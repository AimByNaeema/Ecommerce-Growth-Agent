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
// analytics_data_retrieval, live_competitor_research, shopify_vendor_correction,
// shopify_inventory_correction, and shopify_collection_membership_update are the
// twenty-six entries actually implemented (see tools/businessConfigurationRetrieval.js,
// tools/aiReasoningCompletion.js, tools/marketResearchTool.js,
// tools/customerResearchTool.js, tools/globalMarketOpportunityTool.js,
// tools/competitorResearchTool.js, tools/productDataRetrievalTool.js,
// tools/collectionDataRetrievalTool.js, tools/marketProductOpportunityTool.js,
// tools/keywordResearchTool.js, tools/seoAnalysisTool.js, tools/listingContentTool.js,
// tools/marketingAnalysisTool.js, tools/socialContentTool.js,
// tools/paidAdvertisingTool.js, tools/socialMediaStrategyTool.js,
// tools/platformContentTool.js, tools/contentCalendarTool.js,
// tools/advertisingStrategyTool.js, tools/advertisingPerformanceTool.js,
// tools/analyticsTool.js, tools/analyticsDataTool.js,
// tools/webCompetitorResearchTool.js, tools/productResearchTool.js,
// tools/offerRecommendationTool.js) - the other 2 tools (memory_retrieval,
// verification) remain 'not_implemented'.
//
// THE THREE shopify_* CORRECTION ENTRIES ARE THE EXCEPTION, AND SAY SO IN THEIR OWN
// DESCRIPTIONS. There are no tools/shopify*CorrectionTool.js wrapper files - an earlier
// version of this header named three that were never written - and there is deliberately
// no TOOL_EXECUTORS entry for any of them, because ordinary dispatch must never be able to
// run a consequential mutation. They are reached ONLY by
// agent/core/orchestratorExecutionContract.js's resumeApprovedExecution(), after a real
// Ed25519-verified human approval, via integrations/approvedCorrectionDispatch.js. Their
// capability lives in integrations/shopify*.js, which re-checks compliance and publish
// authorization for itself. See each entry's own description.
//
// This is a single shared list for the ONE agent - every entry is a capability that
// agent can eventually use, never a separate agent, persona, or system prompt. See
// agent/core/agentContract.js's select_tools stage, which this registry exists to
// support.

// The platform vocabulary is agent/core/channelModel.js's, never a second copy of it -
// see TOOL_PLATFORMS below. channelModel.js requires nothing, so this introduces no
// cycle (agent/core/toolPermissions.js already requires this file).
const { CHANNELS } = require('../agent/core/channelModel');

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
//   - 'execute' - calls or changes an external system directly, once authorized. The
//                 three shopify_vendor_correction/shopify_inventory_correction/
//                 shopify_collection_membership_update tools below are the first (see
//                 approvals/approvalArchitecture.js's 'externally_executable' class,
//                 which every one of them is classified under in
//                 agent/core/toolPermissions.js's TOOL_CLASSIFICATIONS).
const TOOL_OPERATIONS = ['read', 'write', 'execute'];

// The e-commerce platform(s) each tool actually reaches, as a THIRD axis independent of
// both `category` (which specialist domain owns it) and `operation` (what kind of work
// it does). This is the axis agent/core/toolPermissions.js's platform gate reads: a tool
// bound to a platform a business has not enabled is denied, however well-owned and
// role-permitted it is.
//
// AN ARRAY, NOT A SINGLE VALUE, AND `[]` IS THE NEUTRAL CASE:
//   - []                     - platform-neutral. The tool reaches no e-commerce platform
//                              at all: it composes caller-supplied records, calls a model,
//                              or searches the public web. 29 of the 39 tools below.
//   - ['shopify'] / ['etsy'] - bound to exactly that platform.
//   - ['shopify', 'etsy']    - genuinely reaches BOTH. Exactly one tool does today
//                              (catalogue_expansion_opportunities, whose
//                              tools/customerMarketOpportunityTool.js reads the Shopify
//                              catalogue and the Etsy listings independently in one
//                              Promise.all and contributes nothing for an unconnected
//                              channel). A single-value field could only have recorded
//                              that tool falsely, which is why this is an array.
//
// NEVER GUESSED. A tool is marked platform-bound only where its own implementation
// reaches an adapter: the seven tool files that require() integrations/adapters/
// shopifyClient.js or etsyReadClient.js, plus the three shopify_* correction entries
// whose registry descriptions name the Shopify mutation each one calls. Every other
// entry is [] because nothing in it touches a platform.
//
// TOOL_PLATFORMS is agent/core/channelModel.js's CHANNELS, reused rather than
// redeclared - so this registry names no platform of its own, and a platform becomes
// nameable here the day a real adapter for it lands, never the day it is discussed.
// Deliberately NOT compliance/compliancePolicy.js's RECOGNIZED_PLATFORMS (a rule-free
// context list that already names amazon/ebay, neither of which has an adapter), and
// deliberately not configuration/business.yaml's free-text `platform:` field.
const TOOL_PLATFORMS = CHANNELS;

const TOOL_REGISTRY = [
  {
    id: 'business_configuration_retrieval',
    title: 'Business configuration retrieval',
    description:
      "Retrieve the connected Shopify store's shop identity (name, domain, email) via integrations/adapters/shopifyClient.js's getShopInfo() - see tools/businessConfigurationRetrieval.js.",
    category: 'configuration',
    operation: 'read',
    status: 'implemented',
    platforms: ['shopify'],
  },
  {
    id: 'product_data_retrieval',
    title: 'Product data retrieval',
    description:
      "Retrieve read-only product data (products, variants, inventory, prices, SKUs, status, collections, metadata) from the connected Shopify store via integrations/adapters/shopifyClient.js's getProducts() - see tools/productDataRetrievalTool.js. No writes.",
    category: 'products',
    operation: 'read',
    status: 'implemented',
    platforms: ['shopify'],
  },
  {
    id: 'collection_data_retrieval',
    title: 'Collection data retrieval',
    description:
      "Retrieve read-only, store-wide collection data (title, handle, description, image, product count) from the connected Shopify store via integrations/adapters/shopifyClient.js's getCollections() - see tools/collectionDataRetrievalTool.js. No writes.",
    category: 'products',
    operation: 'read',
    status: 'implemented',
    platforms: ['shopify'],
  },
  {
    id: 'etsy_shop_data_retrieval',
    title: 'Etsy shop data retrieval',
    description:
      "Retrieve read-only shop data (name, title, currency, listing counts, vacation state) for the connected Etsy shop via integrations/adapters/etsyReadClient.js's getEtsyShop() - see tools/etsyShopDataTool.js. GET requests only; no writes are reachable from that client. The record carries channel: 'etsy' and is never merged with Shopify data.",
    category: 'products',
    operation: 'read',
    status: 'implemented',
    platforms: ['etsy'],
  },
  {
    id: 'etsy_listing_data_retrieval',
    title: 'Etsy listing data retrieval',
    description:
      "Retrieve read-only listing data (title, description, tags, state, price, digital/physical nature) for the connected Etsy shop via integrations/adapters/etsyReadClient.js's getEtsyListings(), with the existing compliance verdict and the product facts the listing data does NOT establish (reported as NEEDS_INFORMATION, never inferred) attached per listing - see tools/etsyListingDataTool.js. GET requests only; no writes are reachable. Records carry channel: 'etsy'.",
    category: 'products',
    operation: 'read',
    status: 'implemented',
    platforms: ['etsy'],
  },
  {
    id: 'market_product_opportunity_analysis',
    title: 'Market-connected product opportunity analysis',
    description:
      "Connect one global market intelligence row (global_market_opportunity_analysis) to one product candidate: Market -> Category -> Trend -> Product -> Competition -> Economics -> Opportunity, producing a real agent/core/opportunityAnalysisModel.js record via workflows/productOpportunityAnalysisWorkflow.js's analyzeProductOpportunityFromMarket() - see tools/marketProductOpportunityTool.js. Economics is pricing/cost inputs only, never a computed margin; assessment/confidence are never invented - an estimate is never presented as a verified fact.",
    category: 'products',
    operation: 'read',
    status: 'implemented',
    platforms: [],
  },
  {
    id: 'product_research',
    title: 'Product research',
    description:
      "Audit, assess, score, and recommend on one already-supplied product record: structural completeness validation, a demand/product risk/profitability inputs assessment, an 8-dimension evidence-coverage score, and a structured recommendation naming its own missing information - via agent/core/productAgent.js's validateProduct()/analyzeProductOpportunity(), productOpportunityScoringEngine.js's scoreProductOpportunity(), and productRecommendationEngine.js's buildProductRecommendation(). See tools/productResearchTool.js. Caller-supplied evidence only, deterministic; profitability is pricing and cost inputs only, never a computed margin; never purchases, publishes, or imports anything.",
    category: 'products',
    operation: 'read',
    status: 'implemented',
    platforms: [],
  },
  {
    id: 'market_research',
    title: 'Market research',
    description:
      "Produce market research records conforming to agent/core/marketResearchModel.js via agent/core/researchAgent.js's runMarketResearch() - see tools/marketResearchTool.js.",
    category: 'research',
    operation: 'read',
    status: 'implemented',
    platforms: [],
  },
  {
    id: 'customer_research',
    title: 'Customer research',
    description:
      "Produce customer segment research records conforming to agent/core/customerSegmentResearchModel.js via agent/core/researchAgent.js's runCustomerMarketIntelligence() - see tools/customerResearchTool.js.",
    category: 'customer_market_intelligence',
    operation: 'read',
    status: 'implemented',
    platforms: [],
  },
  {
    id: 'global_market_opportunity_analysis',
    title: 'Global market opportunity analysis',
    description:
      "Structured global ecommerce market opportunity analysis across 9 evidence-backed dimensions per market/country row (country, category, demand, competition, pricing, trends, customer_need, risk, opportunity) via workflows/globalEcommerceMarketResearchWorkflow.js's compareGlobalMarkets() - see tools/globalMarketOpportunityTool.js. Deterministic composition only, no invented statistic; every fact retains its source/evidence.",
    category: 'research',
    operation: 'read',
    status: 'implemented',
    platforms: [],
  },
  {
    id: 'catalogue_expansion_opportunities',
    title: 'Catalogue expansion opportunities',
    description:
      "Answers \"what should this store sell next\": ranks the strongest adjacent opportunities for one specific seller, using its own catalogue as the starting point. See workflows/customerMarketOpportunityWorkflow.js. Staged, read-only, evidence-verified; ends at a ranked shortlist and never creates, prices or publishes anything.",
    category: 'products',
    operation: 'read',
    status: 'implemented',
    platforms: ['shopify', 'etsy'],
  },
  {
    id: 'competitor_research',
    title: 'Competitor research',
    description:
      "Produce competitor research records - covering a business's known competitors - conforming to agent/core/competitorResearchModel.js via agent/core/researchAgent.js's runCompetitorResearch() - see tools/competitorResearchTool.js.",
    category: 'research',
    operation: 'read',
    status: 'implemented',
    platforms: [],
  },
  {
    id: 'research_analysis',
    title: 'Research analysis',
    description:
      "Trend research over observed trends, trending or emerging seasonal shifts; opportunity discovery to discover and structure signals a caller has already observed; and a global multi-market study spanning several countries or markets at once. Composes agent/core/researchAgent.js records from caller-supplied evidence via runResearch() - the three capabilities with no dedicated tool. See tools/researchAnalysisTool.js.",
    category: 'research',
    operation: 'read',
    status: 'implemented',
    platforms: [],
  },
  {
    id: 'keyword_research',
    title: 'Keyword research',
    description:
      "Produce agent/core/seoResearchModel.js keyword records and search-intent groupings via agent/core/seoAgent.js's runKeywordResearch()/analyzeSearchIntent(), following the workflows/keywordResearchWorkflow.js pipeline - see tools/keywordResearchTool.js.",
    category: 'seo',
    operation: 'read',
    status: 'implemented',
    platforms: [],
  },
  {
    id: 'seo_analysis',
    title: 'SEO analysis',
    description:
      "Analyze product/collection/content on-page SEO and SEO opportunity coverage via agent/core/seoAgent.js, composing agent/core/listingOptimizationModel.js and agent/core/onPageOptimizationModel.js records - see tools/seoAnalysisTool.js.",
    category: 'seo',
    operation: 'read',
    status: 'implemented',
    platforms: [],
  },
  {
    id: 'listing_content_generation',
    title: 'Listing content generation',
    description:
      "Compose agent/core/listingContentModel.js listing-content records (title, description, benefits, features, selling points, FAQs, attributes, variants) and agent/core/marketplaceListingFormatModel.js marketplace-formatted records via agent/core/listingAgent.js - see tools/listingContentTool.js.",
    category: 'listing',
    operation: 'write',
    status: 'implemented',
    platforms: [],
  },
  {
    id: 'marketing_analysis',
    title: 'Marketing analysis',
    description:
      "Produce agent/core/marketingAnalysisModel.js, agent/core/growthOpportunityModel.js, and agent/core/customerSegmentResearchModel.js records via agent/core/marketingAgent.js's 8 capabilities (marketing strategy, audience segmentation, offers, promotions, retention, campaign planning, email strategy, conversion opportunities) - see tools/marketingAnalysisTool.js.",
    category: 'marketing',
    operation: 'write',
    status: 'implemented',
    platforms: [],
  },
  {
    // Deliberately narrow wording: this description competes with marketing_analysis's
    // for the same specialist's objectives under buildPlanStep's word-overlap scoring,
    // so it names only this tool's own distinctive vocabulary (bundle, discount depth,
    // upsell, cross-sell, incentive, value proposition, objection, margin floor) and
    // avoids marketing_analysis's ("marketing", "campaign", "strategy", "segment").
    id: 'offer_recommendation',
    title: 'Offer recommendation',
    description:
      "Audit one product across 7 offer dimensions - bundle, discount, upsell, cross-sell, incentive, value proposition, objection handling - via agent/core/offerRecommendationEngine.js, producing an agent/core/offerRecommendationModel.js record. Discount is the one computed dimension: the depth that keeps margin at or above a caller-supplied floor, plain arithmetic over supplied cost/price, never a guessed promotional idea. Relays only what the caller supplied, flags absolute claims that no supplied evidence backs, and reports each dimension it had nothing to work with honestly - see tools/offerRecommendationTool.js. Applies or publishes nothing.",
    category: 'marketing',
    operation: 'write',
    status: 'implemented',
    platforms: [],
  },
  {
    id: 'social_content_planning',
    title: 'Social content planning',
    description:
      "Compose agent/core/socialContentModel.js social media content records via agent/core/socialAdvertisingAgent.js's 5 social capabilities (instagram, facebook, tiktok, pinterest, youtube) - see tools/socialContentTool.js.",
    category: 'social_advertising',
    operation: 'write',
    status: 'implemented',
    platforms: [],
  },
  {
    id: 'paid_advertising_planning',
    title: 'Paid advertising planning',
    description:
      "Compose agent/core/adCampaignModel.js paid ad campaign records via agent/core/socialAdvertisingAgent.js's 3 advertising capabilities (meta_ads, google_ads, tiktok_ads) - see tools/paidAdvertisingTool.js.",
    category: 'social_advertising',
    operation: 'write',
    status: 'implemented',
    platforms: [],
  },
  {
    id: 'social_media_strategy_generation',
    title: 'Social media strategy generation',
    description:
      "Compose agent/core/socialMediaStrategyModel.js cross-platform strategy records (content pillars, audience, platform selection, posting strategy, content themes, campaign themes, KPIs) via agent/core/socialAdvertisingAgent.js's social_media_strategy capability - see tools/socialMediaStrategyTool.js.",
    category: 'social_advertising',
    operation: 'write',
    status: 'implemented',
    platforms: [],
  },
  {
    id: 'platform_content_generation',
    title: 'Platform-aware ecommerce content generation',
    description:
      "Compose agent/core/platformContentModel.js content records (hooks, captions, CTAs, content ideas, short-form video concepts, carousel concepts, creative briefs, all adapted to one selected platform) via agent/core/socialAdvertisingAgent.js's content_generation capability - see tools/platformContentTool.js.",
    category: 'social_advertising',
    operation: 'write',
    status: 'implemented',
    platforms: [],
  },
  {
    id: 'content_calendar_generation',
    title: 'Social content calendar generation',
    description:
      "Compose agent/core/contentCalendarModel.js calendar entries (date, platform, content type, topic, hook, CTA, campaign, product, KPI) via agent/core/socialAdvertisingAgent.js's content_calendar capability, optionally informed by Marketing Agent campaign context via agent/core/marketingAgent.js's campaign_plan builder - see tools/contentCalendarTool.js.",
    category: 'social_advertising',
    operation: 'write',
    status: 'implemented',
    platforms: [],
  },
  {
    id: 'advertising_strategy_planning',
    title: 'Advertising strategy planning',
    description:
      "Compose agent/core/advertisingStrategyModel.js pre-launch advertising strategy records (campaign objective, audience, offer, creative angle, ad copy, CTA, budget recommendation, KPI, testing plan) via agent/core/socialAdvertisingAgent.js's advertising_strategy capability - see tools/advertisingStrategyTool.js.",
    category: 'social_advertising',
    operation: 'write',
    status: 'implemented',
    platforms: [],
  },
  {
    id: 'advertising_performance_analysis',
    title: 'Advertising performance analysis',
    description:
      "Compose agent/core/advertisingPerformanceModel.js performance records (impressions, CTR, CPC, CPM, conversions, CPA, ROAS) via agent/core/socialAdvertisingAgent.js's advertising_performance capability, separating caller-supplied actual metrics from metrics agent/core/advertisingPerformanceCalculator.js derives from them, and from recommendations - see tools/advertisingPerformanceTool.js.",
    category: 'social_advertising',
    operation: 'read',
    status: 'implemented',
    platforms: [],
  },
  {
    id: 'analytics',
    title: 'Analytics',
    description:
      "Compose agent/core/analyticsModel.js snapshot records (sales, products, customers, conversion, traffic, marketing, advertising, inventory) and agent/core/growthOpportunityModel.js records (growth opportunities) from CALLER-SUPPLIED evidence, via agent/core/analyticsAgent.js's 9 capabilities - see tools/analyticsTool.js.",
    category: 'analytics',
    operation: 'read',
    status: 'implemented',
    platforms: [],
  },
  {
    id: 'analytics_data_retrieval',
    title: 'Analytics data retrieval',
    description:
      "Retrieve read-only LIVE data (orders, products, customers, inventory) from the connected Shopify store via integrations/adapters/shopifyClient.js, compute agent/core/analyticsMetricsCalculator.js's calculated/estimated metrics from it, and compose the result via agent/core/analyticsAgent.js's sales/products/customers/inventory capabilities - see tools/analyticsDataTool.js. No writes; customers uses non-PII fields only.",
    category: 'analytics',
    operation: 'read',
    status: 'implemented',
    platforms: ['shopify'],
  },
  {
    id: 'ai_reasoning_completion',
    title: 'AI reasoning completion',
    description:
      "Run one structured Claude completion (instruction + optional context) via agent/core/claudeClient.js's sendMessage() - see tools/aiReasoningCompletion.js. Every call is capped/budgeted by agent/core/tokenControls.js.",
    category: 'ai_reasoning',
    operation: 'write',
    status: 'implemented',
    platforms: [],
  },
  {
    id: 'memory_retrieval',
    title: 'Memory retrieval',
    description:
      'Retrieve persisted state from memory/state/ per agent/core/memoryRules.js and agent/core/stateModel.js.',
    category: 'memory',
    operation: 'read',
    status: 'not_implemented',
    platforms: [],
  },
  {
    id: 'verification',
    title: 'Verification',
    description:
      "Verify results/evidence per agent/core/researchRecordModel.js's confidence/verification_status convention and the agent contract's verify_results stage.",
    category: 'verification',
    operation: 'read',
    status: 'not_implemented',
    platforms: [],
  },
  {
    id: 'live_competitor_research',
    title: 'Live web competitor research',
    description:
      "Find real, currently-operating competitors via Anthropic's hosted web_search tool (agent/core/claudeClient.js's sendMessage `tools` passthrough), verify every claimed competitor against the search results actually returned, and compose the result via agent/core/researchAgent.js's runCompetitorResearch() - see tools/webCompetitorResearchTool.js. The Research specialist's live counterpart to competitor_research, dispatched only when a free-text objective supplies no structured research_params. No writes; never reports an unverified competitor as real.",
    category: 'research',
    operation: 'read',
    status: 'implemented',
    platforms: [],
  },
  {
    id: 'discover_market_questions',
    title: 'Real market question discovery',
    description:
      "Find real questions people publicly ask about a topic via Anthropic's hosted web_search tool (agent/core/claudeClient.js's sendMessage `tools` passthrough), verify every claimed question against the search results actually returned, and normalize/deduplicate them into agent/core/questionEvidenceModel.js evidence records - see tools/marketQuestionDiscoveryTool.js. The evidence-acquisition layer upstream of the SEO specialist's information_gap_analysis capability: its output feeds agent/core/informationGapEngine.js directly. No writes, no scraping, no new credential; a question whose source cannot be verified is reported as model-generated, never as a real market question.",
    category: 'seo',
    operation: 'read',
    status: 'implemented',
    platforms: [],
  },
  {
    id: 'seo_content_generation',
    title: 'SEO content generation from an information gap',
    description:
      "Turn a validated information-gap opportunity (agent/core/informationGapModel.js) into a structured content brief and, only when the evidence justifies it, a content draft - see tools/seoContentGenerationTool.js. Deterministic gating/brief/post-checks live in agent/core/contentBriefEngine.js; the single model call reuses tools/aiReasoningCompletion.js, so AI_PROVIDER selection and the shared token budget apply unchanged. The one 'write' tool the SEO specialist owns: it authors website content answering a real customer question, which the listing-shaped agent/core/listingAgent.js cannot produce. Publishes nothing - its output is a draft for Compliance and human approval; an unevidenced opportunity is blocked before any model call is made.",
    category: 'seo',
    operation: 'write',
    status: 'implemented',
    platforms: [],
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
    platforms: [],
  },
  {
    id: 'seo_quality_check',
    title: 'SEO quality check',
    description:
      "Audit one already-built listing optimization record across its SEO quality dimensions - keyword usage, meta completeness, heading structure, readability, duplicate content risk, thin content, over-optimization, internal linking opportunities - via agent/core/seoQualityChecker.js's checkSeoQuality(), composing an agent/core/seoQualityCheckModel.js record. Relays only what the caller supplied, reports each dimension it had nothing to work with honestly, never rewrites content. See tools/seoQualityCheckTool.js.",
    category: 'seo',
    operation: 'read',
    status: 'implemented',
    platforms: [],
  },
  {
    id: 'listing_quality_check',
    title: 'Listing quality check',
    description:
      "Audit one already-built listing content record across its quality dimensions - completeness, clarity, accuracy, conversion quality, SEO compatibility, customer objection coverage, missing information, unsupported claims - via agent/core/listingQualityChecker.js's checkListingQuality(), composing an agent/core/listingQualityCheckModel.js record. Relays only what the caller supplied, flags absolute claims that no supplied evidence backs, never rewrites content. See tools/listingQualityCheckTool.js.",
    category: 'listing',
    operation: 'write',
    status: 'implemented',
    platforms: [],
  },
  {
    id: 'shopify_vendor_correction',
    title: 'Shopify product vendor correction',
    description:
      "Correct one product's vendor field via integrations/adapters/shopifyClient.js's productUpdate-backed updateProductVendor(), reached only through integrations/shopifyVendorCorrection.js's correctProductVendor() and its compliance/approval/publish-authorization re-check. Changes ONLY the vendor field - no other field, no price, no content. The first 'execute' tool: it calls the external Shopify store directly once authorized, unlike every 'write' tool above which only composes a draft for a human to review. REACHABLE ONLY THROUGH AN APPROVED EXECUTION: it has no TOOL_EXECUTORS entry, because ordinary dispatch must never be able to run it. agent/core/orchestratorExecutionContract.js's resumeApprovedExecution() routes it to integrations/approvedCorrectionDispatch.js, which loads the approval from durable state, requires genuine Ed25519 provenance, claims it execute-once, and then calls the integration module, which re-checks compliance and publish authorization for itself beforehand.",
    category: 'products',
    operation: 'execute',
    status: 'implemented',
    platforms: ['shopify'],
  },
  {
    id: 'shopify_inventory_correction',
    title: 'Shopify inventory deficit correction',
    description:
      "Restore inventory available quantity via integrations/adapters/shopifyClient.js's inventoryAdjustQuantities-backed adjustInventoryQuantities(), reached only through integrations/shopifyInventoryCorrection.js's correctInventoryDeficit(). The restored amount is always exactly the sum of quantities decremented by Shopify's own test:true orders for that inventory item (planInventoryCorrections()) - never an invented or guessed figure; an item whose deficit does not fully reconcile against test orders is reported unresolved, not corrected. REACHABLE ONLY THROUGH AN APPROVED EXECUTION: it has no TOOL_EXECUTORS entry, because ordinary dispatch must never be able to run it. agent/core/orchestratorExecutionContract.js's resumeApprovedExecution() routes it to integrations/approvedCorrectionDispatch.js, which loads the approval from durable state, requires genuine Ed25519 provenance, claims it execute-once, and then calls the integration module, which re-checks compliance and publish authorization for itself beforehand.",
    category: 'products',
    operation: 'execute',
    status: 'implemented',
    platforms: ['shopify'],
  },
  {
    id: 'shopify_collection_membership_update',
    title: 'Shopify collection membership update',
    description:
      "Add one product to one existing Shopify collection via integrations/adapters/shopifyClient.js's collectionAddProducts-backed addProductsToCollection(), reached only through integrations/shopifyCollectionMembership.js's addProductToFreeDesignsCollection(). Never creates a collection, never touches any other collection or field. REACHABLE ONLY THROUGH AN APPROVED EXECUTION: it has no TOOL_EXECUTORS entry, because ordinary dispatch must never be able to run it. agent/core/orchestratorExecutionContract.js's resumeApprovedExecution() routes it to integrations/approvedCorrectionDispatch.js, which loads the approval from durable state, requires genuine Ed25519 provenance, claims it execute-once, and then calls the integration module, which re-checks compliance and publish authorization for itself beforehand.",
    category: 'products',
    operation: 'execute',
    status: 'implemented',
    platforms: ['shopify'],
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

// The tools bound to one platform, or - for `null`/omitted - the platform-NEUTRAL tools
// (those reaching no e-commerce platform at all). Same one-line filter shape as
// getToolsByCategory/getToolsByStatus/getToolsByOperation above; it reads the `platforms`
// array rather than comparing a scalar, because a tool may legitimately name more than
// one platform (see TOOL_PLATFORMS).
//
// An unrecognized platform returns [] rather than throwing: this is a read-only lookup
// like every other helper here, and "no tool is bound to that platform" is the honest
// answer for a platform this project has no adapter for. Refusing an unknown platform is
// the PERMISSION layer's job, and agent/core/toolPermissions.js does refuse it.
function getToolsByPlatform(platform) {
  if (platform === null || platform === undefined) {
    return TOOL_REGISTRY.filter((tool) => tool.platforms.length === 0);
  }
  return TOOL_REGISTRY.filter((tool) => tool.platforms.includes(platform));
}

module.exports = {
  TOOL_CATEGORIES,
  TOOL_STATUSES,
  TOOL_OPERATIONS,
  TOOL_PLATFORMS,
  TOOL_REGISTRY,
  getToolRegistry,
  getToolById,
  getToolsByCategory,
  getToolsByStatus,
  getToolsByOperation,
  getToolsByPlatform,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - tool registry (foundation only):\n');
  for (const category of TOOL_CATEGORIES) {
    const toolsInCategory = getToolsByCategory(category);
    if (toolsInCategory.length === 0) continue;
    console.log(`[${category}]`);
    for (const tool of toolsInCategory) {
      const platformNote = tool.platforms.length === 0 ? 'platform-neutral' : tool.platforms.join('+');
      console.log(`  - ${tool.id} (${tool.status}, ${tool.operation}, ${platformNote}): ${tool.title}`);
      console.log(`      ${tool.description}`);
    }
  }
  const implementedCount = getToolsByStatus('implemented').length;
  console.log(`\n${TOOL_REGISTRY.length} tools registered, ${implementedCount} implemented - registry foundation only.`);

  console.log(`\nPlatform binding (TOOL_PLATFORMS, reused from agent/core/channelModel.js: ${TOOL_PLATFORMS.join(', ')}):`);
  console.log(`  platform-neutral (${getToolsByPlatform(null).length}): reach no e-commerce platform at all`);
  for (const platform of TOOL_PLATFORMS) {
    const bound = getToolsByPlatform(platform);
    console.log(`  ${platform} (${bound.length}): ${bound.map((tool) => tool.id).join(', ')}`);
  }
  console.log('A tool bound to a platform a business has not enabled is denied by agent/core/toolPermissions.js,');
  console.log('which reads configuration alone - never whichever credentials happen to be present.');
  console.log('No tool is ever called from this file - dispatch lives in agent/core/orchestratorExecutionContract.js, gated by agent/core/toolPermissions.js.');
}
