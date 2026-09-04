'use strict';

// The Specialist Capability Registry - for each of CLAUDE.md section 2's 7 approved
// specialists, declares supported tasks, required tools, input contract, output
// contract, permissions, and approval requirements, in one place. This is a
// COMPOSITION layer only: every field below is either reused verbatim from an
// existing registry/module, or mechanically derived from one - nothing here
// reimplements agent/core/specialistRegistry.js's specialist list,
// tools/toolRegistry.js's tool list, agent/core/toolPermissions.js's permission
// logic, or approvals/approvalArchitecture.js's approval classifications. See
// agent/core/specialistCapabilityModel.js for the schema this file's output
// conforms to.
//
// Reuse map:
//   id/title/description/status  <- agent/core/specialistRegistry.js
//   required_tools                <- tools/toolRegistry.js + toolPermissions.js's
//                                     SPECIALIST_TO_CATEGORIES (derived, not hand-listed)
//   permissions.tool_access        <- toolPermissions.js's checkToolAccess(), called
//                                     directly, never reimplemented
//   approval_requirements          <- approvalArchitecture.js's ACTION_CLASSIFICATIONS
//                                     via getClassificationById(), same reuse pattern
//                                     agent/core/growthOpportunityEngineModel.js
//                                     already established
//   supported_tasks[].id            <- each specialist's own capability enum
//                                     (RESEARCH_TYPES, SEO_CAPABILITIES,
//                                     LISTING_CAPABILITIES, MARKETING_CAPABILITIES,
//                                     SOCIAL_ADVERTISING_CAPABILITIES,
//                                     ANALYTICS_CAPABILITIES) - except Product, which
//                                     has none (see PRODUCT_CAPABILITY_IDS below)
//   supported_tasks[].output_contract.fields <- each specialist's own *_FIELDS export,
//                                     mapped to .id - never re-typed
//
// The only genuinely new, hand-authored data is: capability titles/descriptions,
// each task's input_contract (grounded exactly in the real requireNonEmptyString/
// requireNonEmptyArray calls and optional-param usage verified directly against
// agent/core/researchAgent.js, productAgent.js, productOpportunityScoringEngine.js,
// productRecommendationEngine.js, seoAgent.js, listingAgent.js, marketingAgent.js,
// socialAdvertisingAgent.js, and analyticsAgent.js source - nothing invented beyond
// what those files actually enforce), and PRODUCT_CAPABILITY_IDS itself.
//
// HONEST tool_ids GAPS - deliberately left as an empty array, never fabricated to
// look complete: agent/core/researchAgent.js's global_market_research,
// trend_research, and opportunity_discovery (no tool in tools/toolRegistry.js wraps
// any of them yet); 4 of 5 Product capabilities - product_validation,
// product_opportunity_analysis, product_opportunity_scoring, product_recommendation -
// still have no wrapper (tools/toolRegistry.js's 'product_research' entry, the
// would-be wrapper, is still 'not_implemented'). product_discovery is the one
// exception: tools/productDataRetrievalTool.js's runProductDataRetrievalTool() wraps
// it via a live, read-only Shopify product pull (product_data_retrieval) - see
// live_data_tool_id below.
//
// live_data_tool_id (agent/core/specialistCapabilityModel.js) - a NEW, additive,
// backward-compatible field (default null): names a tool_ids entry that can satisfy
// this capability entirely from an already-approved read-only live source, needing no
// caller-supplied structured evidence at all. Only set where independently verified
// against the real tool's own behavior - product_discovery (product_data_retrieval)
// and the 4 analytics snapshot tasks with a live counterpart (analytics_data_retrieval
// - see ANALYTICS_DATA_RETRIEVAL_CAPABILITIES below, now also expressed via this
// field). Every other capability leaves it null - an honest gap, not a promise no live
// source exists to build later, just that none exists YET.
//
// EXCLUDED entirely from supported_tasks, matching this project's existing
// standalone-engine precedent (the same treatment agent/core/growthOpportunityEngine.js
// itself gets): agent/core/competitorIntelligenceAgent.js (not called from
// researchAgent.js) and agent/core/offerRecommendationEngine.js (not called from
// marketingAgent.js).
//
// KNOWN `required` GAPS - observed, deliberately not touched by this pass (which
// scoped itself to completing missing `optional` arrays only, to keep the diff
// reviewable): a few tasks' `required` arrays are already incomplete relative to
// what the real handler throws on - e.g. growth_opportunities's required: ['opportunities']
// omits opportunities[].productReference, which buildGrowthOpportunityRecord() does
// requireNonEmptyString() on; seo_opportunity_analysis's required: ['keywords']
// similarly omits keywords[].keyword. Fixing these is a separate, explicitly-scoped
// follow-up, not an oversight of this pass.

const { getSpecialistById } = require('./specialistRegistry');
const { getToolsByCategory } = require('../../tools/toolRegistry');
const { SPECIALIST_TO_CATEGORIES, checkToolAccess } = require('./toolPermissions');
const { getClassificationById } = require('../../approvals/approvalArchitecture');
const {
  createEmptySpecialistCapabilityEntry,
  createEmptyCapabilityTask,
} = require('./specialistCapabilityModel');

const { RESEARCH_TYPES, RESEARCH_AGENT_RESULT_FIELDS } = require('./researchAgentResultModel');
const { SEO_CAPABILITIES, SEO_AGENT_RESULT_FIELDS } = require('./seoAgentResultModel');
const { LISTING_CAPABILITIES, LISTING_AGENT_RESULT_FIELDS } = require('./listingAgentResultModel');
const { MARKETING_CAPABILITIES, MARKETING_AGENT_RESULT_FIELDS } = require('./marketingAgentResultModel');
const {
  SOCIAL_ADVERTISING_CAPABILITIES,
  SOCIAL_ADVERTISING_AGENT_RESULT_FIELDS,
} = require('./socialAdvertisingAgentResultModel');
const { ANALYTICS_CAPABILITIES, ANALYTICS_AGENT_RESULT_FIELDS } = require('./analyticsAgentResultModel');

const { PRODUCT_FIELDS } = require('./productModel');
const { PRODUCT_AGENT_RESULT_FIELDS } = require('./productAgentResultModel');
const { PRODUCT_OPPORTUNITY_SCORE_FIELDS } = require('./productOpportunityScoreModel');
const { PRODUCT_RECOMMENDATION_FIELDS } = require('./productRecommendationModel');
const { GLOBAL_MARKET_COMPARISON_FIELDS } = require('./globalMarketComparisonModel');
const { MARKET_CONNECTED_OPPORTUNITY_FIELDS } = require('./marketConnectedOpportunityModel');

// No existing enum covers productAgent.js's 3 exported functions plus
// productOpportunityScoringEngine.js's and productRecommendationEngine.js's 1 each
// (unlike the other 6 specialists, whose *AgentResultModel.js already exports a
// capability enum) - this is the one genuinely new vocabulary this registry defines,
// grounded 1:1 in those 3 files' real exports, in the order those modules would
// naturally run in a pipeline (discover -> validate -> analyze -> score -> recommend).
const PRODUCT_CAPABILITY_IDS = [
  'product_discovery',
  'product_validation',
  'product_opportunity_analysis',
  'market_product_opportunity_analysis',
  'product_opportunity_scoring',
  'product_recommendation',
];

// researchAgent.js's own RESEARCH_TYPES enum doesn't cover
// global_market_opportunity_analysis - that capability is implemented via a separate
// workflow (workflows/globalEcommerceMarketResearchWorkflow.js), not one of
// researchAgent.js's own dispatch modes - the same reason PRODUCT_CAPABILITY_IDS
// above already needed to be a registry-local list rather than an imported agent
// enum. Order matches RESEARCH_TASKS below exactly.
const RESEARCH_CAPABILITY_IDS = [
  'market_research',
  'global_market_research',
  'competitor_research',
  'trend_research',
  'global_market_opportunity_analysis',
  'customer_market_intelligence',
  'opportunity_discovery',
  'customer_segmentation',
];

function fieldIds(fieldsList) {
  return fieldsList.map((field) => field.id);
}

function buildTask({
  id,
  title,
  description,
  toolIds = [],
  required = [],
  optional = [],
  model = null,
  fields = [],
  liveDataToolId = null,
}) {
  const task = createEmptyCapabilityTask(id);
  task.title = title;
  task.description = description;
  task.tool_ids = toolIds;
  task.input_contract = { required, optional };
  task.output_contract = { model, fields };
  task.live_data_tool_id = liveDataToolId;
  return task;
}

// Derives required_tools/permissions/approval_requirements purely from
// tools/toolRegistry.js + agent/core/toolPermissions.js + approvals/approvalArchitecture.js
// - never hand-listed, never reimplemented.
function buildEntry(specialistId, supportedTasks) {
  const specialist = getSpecialistById(specialistId);
  const entry = createEmptySpecialistCapabilityEntry(specialistId);
  entry.title = specialist.title;
  entry.description = specialist.description;
  entry.status = specialist.status;
  entry.supported_tasks = supportedTasks;

  const categories = SPECIALIST_TO_CATEGORIES[specialistId] || [];
  const requiredTools = [];
  for (const category of categories) {
    for (const tool of getToolsByCategory(category)) {
      if (!requiredTools.includes(tool.id)) requiredTools.push(tool.id);
    }
  }
  entry.required_tools = requiredTools;

  const toolAccess = requiredTools.map((toolId) => checkToolAccess({ specialistId, toolId }));
  entry.permissions = { categories, tool_access: toolAccess };

  // requires_human_approval is true whenever checkToolAccess() reports
  // approval_required: true OR null (the 'unavailable' case) - an unavailable tool
  // must never be reported as silently fine, per approvalArchitecture.js's
  // never_silent_consequential_action policy rule.
  entry.approval_requirements = toolAccess.map((access) => {
    const classification = access.classification ? getClassificationById(access.classification) : null;
    return {
      tool_id: access.tool_id,
      classification: access.classification || null,
      title: classification ? classification.title : null,
      description: classification ? classification.description : null,
      requires_human_approval: access.approval_required !== false,
    };
  });

  return entry;
}

// ---------------------------------------------------------------------------------
// Research (agent/core/researchAgent.js)
// ---------------------------------------------------------------------------------

const RESEARCH_TASKS = [
  buildTask({
    id: 'market_research',
    title: 'Market research',
    description:
      "Produce one market research record for a named market, composing caller-supplied findings/evidence/source via researchAgent.js's runMarketResearch().",
    toolIds: ['market_research'],
    required: ['market'],
    optional: [
      'country',
      'category',
      'customerSegment',
      'demandSignals',
      'competitors',
      'trends',
      'opportunities',
      'risks',
      'evidence',
      'researchDate',
      'topic',
      'confidence',
      'recommendations',
      'verificationStatus',
    ],
    model: 'agent/core/researchAgentResultModel.js',
    fields: fieldIds(RESEARCH_AGENT_RESULT_FIELDS),
  }),
  buildTask({
    id: 'global_market_research',
    title: 'Global market research',
    description:
      "Produce one specialized market research record per market entry across a caller-supplied list of markets, via researchAgent.js's runGlobalMarketResearch(). Not yet wired to any tool in tools/toolRegistry.js.",
    toolIds: [],
    required: ['markets', 'markets[].market'],
    optional: [
      'markets[].country',
      'markets[].category',
      'markets[].customerSegment',
      'markets[].demandSignals',
      'markets[].competitors',
      'markets[].trends',
      'markets[].opportunities',
      'markets[].risks',
      'markets[].evidence',
      'markets[].researchDate',
      'category',
      'customerSegment',
      'researchDate',
      'topic',
      'confidence',
      'recommendations',
      'verificationStatus',
    ],
    model: 'agent/core/researchAgentResultModel.js',
    fields: fieldIds(RESEARCH_AGENT_RESULT_FIELDS),
  }),
  buildTask({
    id: 'competitor_research',
    title: 'Competitor research',
    description:
      "Produce one competitor research record per caller-supplied competitor via researchAgent.js's runCompetitorResearch(). live_competitor_research (tools/webCompetitorResearchTool.js) is this task's own live counterpart for a free-text objective with no caller-supplied competitors - deliberately NOT expressed via live_data_tool_id below (left null on purpose): that generic mechanism also makes a declared live source a fallback for every OTHER Research task with no live source of its own (see agent/core/orchestratorExecutionContract.js's CROSS-CAPABILITY LIVE-DATA FALLBACK), which would wrongly substitute real competitor data for an unrelated research type (e.g. market_research) just because it is the only live source in this specialist's tool set. Instead, agent/core/orchestratorExecutionContract.js's buildPlanStep has its own narrow, explicitly-scoped 'LIVE WEB COMPETITOR RESEARCH' block that only ever swaps to live_competitor_research once routing has already resolved specifically to this competitor_research task.",
    toolIds: ['competitor_research', 'live_competitor_research'],
    required: ['competitors', 'competitors[].competitor'],
    // No top-level `market` - runCompetitorResearch() never reads params.market
    // (only each entry's own competitors[].market), verified against source.
    optional: [
      'competitors[].market',
      'competitors[].productCategory',
      'competitors[].positioning',
      'competitors[].pricingEvidence',
      'competitors[].strengths',
      'competitors[].weaknesses',
      'competitors[].marketingSignals',
      'competitors[].seoSignals',
      'competitors[].opportunities',
      'competitors[].source',
      'competitors[].researchDate',
      'topic',
      'confidence',
      'recommendations',
      'verificationStatus',
    ],
    model: 'agent/core/researchAgentResultModel.js',
    fields: fieldIds(RESEARCH_AGENT_RESULT_FIELDS),
  }),
  buildTask({
    id: 'trend_research',
    title: 'Trend research',
    description:
      "Produce one trend research record per caller-supplied trend topic via researchAgent.js's runTrendResearch(). Not yet wired to any tool in tools/toolRegistry.js.",
    toolIds: [],
    required: ['trends', 'trends[].topic'],
    optional: [
      'trends[].market',
      'trends[].date',
      'trends[].source',
      'trends[].finding',
      'trends[].confidence',
      'trends[].relevance',
      'trends[].summary',
      'trends[].verificationStatus',
      'market',
      'topic',
      'confidence',
      'recommendations',
      'verificationStatus',
    ],
    model: 'agent/core/researchAgentResultModel.js',
    fields: fieldIds(RESEARCH_AGENT_RESULT_FIELDS),
  }),
  buildTask({
    id: 'global_market_opportunity_analysis',
    title: 'Global market opportunity analysis',
    description:
      "Compose one agent/core/globalMarketComparisonModel.js comparison row per caller-supplied market, across 9 evidence facets (category, demand_signals, competition, pricing, trends, customer_need, risks, opportunities, products), via workflows/globalEcommerceMarketResearchWorkflow.js's compareGlobalMarkets(). The global_market_opportunity_analysis tool's only mode.",
    toolIds: ['global_market_opportunity_analysis'],
    required: ['markets', 'markets[].market'],
    optional: [
      'markets[].country',
      'markets[].category',
      'markets[].demandSignals',
      'markets[].trends',
      'markets[].risks',
      'markets[].opportunities',
      'markets[].evidence',
      'markets[].customerSegments',
      'markets[].customerSegments[].segmentDefinition',
      'markets[].customerSegments[].needs',
      'markets[].customerSegments[].evidence',
      'markets[].competitors',
      'markets[].competitors[].competitor',
      'markets[].competitors[].positioning',
      'markets[].competitors[].pricingEvidence',
      'markets[].competitors[].strengths',
      'markets[].competitors[].source',
      'markets[].products',
      'markets[].products[].productIdentity',
      'markets[].products[].pricing',
      'markets[].products[].source',
      'topic',
    ],
    model: 'agent/core/globalMarketComparisonModel.js',
    fields: fieldIds(GLOBAL_MARKET_COMPARISON_FIELDS),
  }),
  buildTask({
    id: 'customer_market_intelligence',
    title: 'Customer market intelligence',
    description:
      "Produce one customer market intelligence record per caller-supplied segment via researchAgent.js's runCustomerMarketIntelligence() - the customer_research tool's default mode (researchParams.customerResearchMode = 'segment_research').",
    toolIds: ['customer_research'],
    required: ['segments', 'segments[].segmentDefinition'],
    // No top-level `market` fallback - runCustomerMarketIntelligence() never reads
    // params.market (only each entry's own segments[].market), verified against source.
    optional: [
      'segments[].needs',
      'segments[].problems',
      'segments[].buyingMotivations',
      'segments[].objections',
      'segments[].preferences',
      'segments[].market',
      'segments[].evidence',
      'segments[].confidence',
      'topic',
      'confidence',
      'recommendations',
      'verificationStatus',
    ],
    model: 'agent/core/researchAgentResultModel.js',
    fields: fieldIds(RESEARCH_AGENT_RESULT_FIELDS),
  }),
  buildTask({
    id: 'opportunity_discovery',
    title: 'Opportunity discovery',
    description:
      "Produce one generic research record per caller-supplied signal via researchAgent.js's runOpportunityDiscovery(). Not yet wired to any tool in tools/toolRegistry.js.",
    toolIds: [],
    required: ['signals', 'signals[].topic'],
    optional: [
      'signals[].market',
      'signals[].date',
      'signals[].source',
      'signals[].finding',
      'signals[].confidence',
      'signals[].relevance',
      'signals[].summary',
      'signals[].verificationStatus',
      'market',
      'topic',
      'confidence',
      'recommendations',
      'verificationStatus',
    ],
    model: 'agent/core/researchAgentResultModel.js',
    fields: fieldIds(RESEARCH_AGENT_RESULT_FIELDS),
  }),
  buildTask({
    id: 'customer_segmentation',
    title: 'Customer segmentation',
    description:
      "Classify one customer from behavioral/business data only (never personal attributes) via researchAgent.js's deriveCustomerSegmentation() - the customer_research tool's other mode (researchParams.customerResearchMode = 'customer_segmentation').",
    toolIds: ['customer_research'],
    required: ['segmentReference'],
    optional: [
      'purchaseBehavior',
      'productInterest',
      'orderFrequency',
      'orderFrequency.orderCount',
      'orderFrequency.daysSinceLastOrder',
      'customerValue',
      'customerValue.lifetimeValue',
      'engagement',
      'engagement.siteVisitsLast30Days',
      'engagement.emailOpenRate',
    ],
    model: 'agent/core/researchAgentResultModel.js',
    fields: fieldIds(RESEARCH_AGENT_RESULT_FIELDS),
  }),
];

// ---------------------------------------------------------------------------------
// Product (agent/core/productAgent.js, productOpportunityScoringEngine.js,
// productRecommendationEngine.js)
// ---------------------------------------------------------------------------------

const PRODUCT_TASKS = [
  buildTask({
    id: 'product_discovery',
    title: 'Product discovery',
    description:
      "Build and validate one agent/core/productModel.js record per candidate entry via productAgent.js's discoverProducts(). Returns an array of records. Wired to tools/productDataRetrievalTool.js's runProductDataRetrievalTool(), which pulls the connected Shopify store's real product catalog and reshapes it into this function's entry shape via mapShopifyProductToCandidate() - self-sufficient from that live source alone, no caller-supplied entries required (see live_data_tool_id below).",
    toolIds: ['product_data_retrieval'],
    liveDataToolId: 'product_data_retrieval',
    required: ['entries', 'entries[].productIdentity'],
    optional: [
      'entries[].category',
      'entries[].productModel',
      'entries[].description',
      'entries[].positioning',
      'entries[].targetCustomer',
      'entries[].market',
      'entries[].pricing',
      'entries[].pricing.currency',
      'entries[].pricing.cost',
      'entries[].pricing.price',
      'entries[].availability',
      'entries[].source',
      'entries[].researchStatus',
    ],
    model: 'agent/core/productModel.js',
    fields: fieldIds(PRODUCT_FIELDS),
  }),
  buildTask({
    id: 'product_validation',
    title: 'Product validation',
    description:
      "Structural completeness audit of one product record via productAgent.js's validateProduct() - never a quality judgment. Returns an ad hoc shape, not a *Model.js record.",
    toolIds: [],
    required: ['productRecord'],
    // optional intentionally left empty - verified against source: validateProduct()
    // reads only its one `productRecord` parameter, nothing else.
    optional: [],
    model: null,
    fields: ['shape_valid', 'shape_errors', 'completeness', 'is_research_ready'],
  }),
  buildTask({
    id: 'product_opportunity_analysis',
    title: 'Product opportunity analysis',
    description:
      "Assess demand/competition/market_fit/product_risk plus profitability inputs and a 4-dimension coverage count for one product via productAgent.js's analyzeProductOpportunity(). Not yet wired to any tool.",
    toolIds: [],
    required: ['productIdentity'],
    optional: [
      'category',
      'productModel',
      'description',
      'positioning',
      'targetCustomer',
      'market',
      'pricing',
      'availability',
      'source',
      'researchStatus',
      'demandAssessment',
      'demandEvidence',
      'demandConfidence',
      'competitionAssessment',
      'competitionEvidence',
      'competitionConfidence',
      'marketFitAssessment',
      'marketFitEvidence',
      'marketFitConfidence',
      'productRiskAssessment',
      'productRiskEvidence',
      'productRiskConfidence',
      'costComponents',
    ],
    model: 'agent/core/productAgentResultModel.js',
    fields: fieldIds(PRODUCT_AGENT_RESULT_FIELDS),
  }),
  buildTask({
    id: 'market_product_opportunity_analysis',
    title: 'Market-connected product opportunity analysis',
    description:
      "Compose one agent/core/marketConnectedOpportunityModel.js record by finding one caller-supplied product inside a real global_market_opportunity_analysis comparison row and assessing its demand/competition/market_relevance/commercial_potential dimensions via workflows/productOpportunityAnalysisWorkflow.js's analyzeProductOpportunityFromMarket() - the market_product_opportunity_analysis tool's only mode.",
    toolIds: ['market_product_opportunity_analysis'],
    required: ['marketRow', 'productIdentity'],
    optional: [
      'demandAssessment',
      'demandConfidence',
      'competitionAssessment',
      'competitionConfidence',
      'marketFitAssessment',
      'marketFitConfidence',
      'commercialPotentialAssessment',
      'commercialPotentialConfidence',
    ],
    model: 'agent/core/marketConnectedOpportunityModel.js',
    fields: fieldIds(MARKET_CONNECTED_OPPORTUNITY_FIELDS),
  }),
  buildTask({
    id: 'product_opportunity_scoring',
    title: 'Product opportunity scoring',
    description:
      "Score 8 dimensions (demand, competition, market_fit, pricing, margin_inputs, trend, risk, differentiation) of one product's opportunity via productOpportunityScoringEngine.js's scoreProductOpportunity() - a mechanical evidence-coverage measurement, never a judgment of quality. Not yet wired to any tool.",
    toolIds: [],
    required: ['productIdentity'],
    optional: [
      'category',
      'market',
      'pricing',
      'source',
      'demandAssessment',
      'demandEvidence',
      'demandConfidence',
      'competitionAssessment',
      'competitionEvidence',
      'competitionConfidence',
      'marketFitAssessment',
      'marketFitEvidence',
      'marketFitConfidence',
      'riskAssessment',
      'riskEvidence',
      'riskConfidence',
      'differentiationAssessment',
      'differentiationEvidence',
      'differentiationConfidence',
      'trendEvidence',
    ],
    model: 'agent/core/productOpportunityScoreModel.js',
    fields: fieldIds(PRODUCT_OPPORTUNITY_SCORE_FIELDS),
  }),
  buildTask({
    id: 'product_recommendation',
    title: 'Product recommendation',
    description:
      "Compose a structured recommendation (opportunity, reasoning, evidence, risks, missing information, confidence, recommended next step) from an already-scored productOpportunityScoreModel.js record via productRecommendationEngine.js's buildProductRecommendation(). Never purchases, publishes, or imports anything. Not yet wired to any tool.",
    toolIds: [],
    required: ['scoreResult'],
    optional: ['recommendedNextStep'],
    model: 'agent/core/productRecommendationModel.js',
    fields: fieldIds(PRODUCT_RECOMMENDATION_FIELDS),
  }),
];

// ---------------------------------------------------------------------------------
// SEO (agent/core/seoAgent.js)
// ---------------------------------------------------------------------------------

const SEO_TASKS = [
  buildTask({
    id: 'keyword_research',
    title: 'Keyword research',
    description: "Produce one SEO keyword record per caller-supplied keyword via seoAgent.js's runKeywordResearch().",
    toolIds: ['keyword_research'],
    required: ['keywords', 'keywords[].keyword'],
    optional: [
      'keywords[].searchIntent',
      'keywords[].market',
      'keywords[].language',
      'keywords[].relevance',
      'keywords[].competition',
      'keywords[].opportunity',
      'keywords[].source',
      'keywords[].researchDate',
      'keywords[].confidence',
      'topic',
      'market',
      'researchDate',
      'confidence',
      'recommendations',
      'verificationStatus',
    ],
    model: 'agent/core/seoAgentResultModel.js',
    fields: fieldIds(SEO_AGENT_RESULT_FIELDS),
  }),
  buildTask({
    id: 'search_intent_analysis',
    title: 'Search intent analysis',
    description:
      "Group caller-supplied keywords by their asserted search_intent via seoAgent.js's analyzeSearchIntent() - the keyword_research tool's other mode (researchParams.seoCapability).",
    toolIds: ['keyword_research'],
    required: ['keywords', 'keywords[].keyword'],
    // No top-level `researchDate` - analyzeSearchIntent() always calls
    // todayIsoDate() directly, never reads params.researchDate (unlike
    // runKeywordResearch above), verified against source.
    optional: [
      'keywords[].searchIntent',
      'keywords[].market',
      'keywords[].language',
      'keywords[].relevance',
      'keywords[].competition',
      'keywords[].opportunity',
      'keywords[].source',
      'keywords[].researchDate',
      'keywords[].confidence',
      'topic',
      'market',
      'confidence',
      'recommendations',
      'verificationStatus',
    ],
    model: 'agent/core/seoAgentResultModel.js',
    fields: fieldIds(SEO_AGENT_RESULT_FIELDS),
  }),
  buildTask({
    id: 'product_seo',
    title: 'Product SEO',
    description:
      "On-page SEO analysis for one product via seoAgent.js's analyzeProductSeo() - the seo_analysis tool's default mode (researchParams.seoCapability).",
    toolIds: ['seo_analysis'],
    required: ['productReference'],
    optional: [
      'productTitle',
      'description',
      'keywords',
      'keywordUsage',
      'searchIntent',
      'structure',
      'headings',
      'metadata',
      'metadata.metaTitle',
      'metadata.metaDescription',
      'metadata.urlSlug',
      'metadata.altText',
      'internalLinks',
      'internalOptimizationOpportunities',
      'conversionConsiderations',
      'supportingContent',
      'evidence',
      'topic',
      'market',
      'confidence',
      'recommendations',
      'verificationStatus',
      'researchDate',
    ],
    model: 'agent/core/seoAgentResultModel.js',
    fields: fieldIds(SEO_AGENT_RESULT_FIELDS),
  }),
  buildTask({
    id: 'collection_seo',
    title: 'Collection SEO',
    description:
      "On-page SEO analysis for one collection via seoAgent.js's analyzeCollectionSeo() - a seo_analysis tool mode (researchParams.seoCapability).",
    toolIds: ['seo_analysis'],
    required: ['collectionReference'],
    optional: [
      'collectionTitle',
      'description',
      'keywords',
      'searchIntent',
      'structure',
      'metadata',
      'metadata.metaTitle',
      'metadata.metaDescription',
      'metadata.urlSlug',
      'metadata.altText',
      'internalOptimizationOpportunities',
      'conversionConsiderations',
      'evidence',
      'topic',
      'market',
      'confidence',
      'recommendations',
      'verificationStatus',
      'researchDate',
    ],
    model: 'agent/core/seoAgentResultModel.js',
    fields: fieldIds(SEO_AGENT_RESULT_FIELDS),
  }),
  buildTask({
    id: 'content_seo',
    title: 'Content SEO',
    description:
      "On-page SEO analysis for one piece of content via seoAgent.js's analyzeContentSeo() - a seo_analysis tool mode (researchParams.seoCapability).",
    toolIds: ['seo_analysis'],
    required: ['contentReference'],
    optional: [
      'contentTitle',
      'description',
      'keywords',
      'searchIntent',
      'structure',
      'metadata',
      'metadata.metaTitle',
      'metadata.metaDescription',
      'metadata.urlSlug',
      'metadata.altText',
      'internalOptimizationOpportunities',
      'conversionConsiderations',
      'evidence',
      'topic',
      'market',
      'confidence',
      'recommendations',
      'verificationStatus',
      'researchDate',
    ],
    model: 'agent/core/seoAgentResultModel.js',
    fields: fieldIds(SEO_AGENT_RESULT_FIELDS),
  }),
  buildTask({
    id: 'on_page_seo',
    title: 'On-page SEO',
    description:
      "Dispatches to product_seo/collection_seo/content_seo by subjectType via seoAgent.js's analyzeOnPageSeo() - a seo_analysis tool mode (researchParams.seoCapability). Composition, not duplication.",
    toolIds: ['seo_analysis'],
    required: ['subjectType'],
    // The union of product_seo/collection_seo/content_seo's own optional fields -
    // the true accepted set is conditional on the runtime `subjectType` value, which
    // this registry's flat required/optional model can't express; documented here
    // rather than silently narrowed to one branch.
    optional: [
      'productReference',
      'productTitle',
      'collectionReference',
      'collectionTitle',
      'contentReference',
      'contentTitle',
      'description',
      'keywords',
      'searchIntent',
      'structure',
      'headings',
      'metadata',
      'metadata.metaTitle',
      'metadata.metaDescription',
      'metadata.urlSlug',
      'metadata.altText',
      'internalLinks',
      'internalOptimizationOpportunities',
      'conversionConsiderations',
      'supportingContent',
      'evidence',
      'topic',
      'market',
      'confidence',
      'recommendations',
      'verificationStatus',
      'researchDate',
    ],
    model: 'agent/core/seoAgentResultModel.js',
    fields: fieldIds(SEO_AGENT_RESULT_FIELDS),
  }),
  buildTask({
    id: 'seo_opportunity_analysis',
    title: 'SEO opportunity analysis',
    description:
      "Structural coverage report across caller-supplied keywords' opportunity/competition fields via seoAgent.js's analyzeSeoOpportunities() - a seo_analysis tool mode (researchParams.seoCapability).",
    toolIds: ['seo_analysis'],
    required: ['keywords'],
    // No top-level `researchDate` - analyzeSeoOpportunities() always calls
    // todayIsoDate() directly, verified against source.
    optional: [
      'keywords[].searchIntent',
      'keywords[].market',
      'keywords[].language',
      'keywords[].relevance',
      'keywords[].competition',
      'keywords[].opportunity',
      'keywords[].source',
      'keywords[].researchDate',
      'keywords[].confidence',
      'topic',
      'market',
      'confidence',
      'recommendations',
      'verificationStatus',
    ],
    model: 'agent/core/seoAgentResultModel.js',
    fields: fieldIds(SEO_AGENT_RESULT_FIELDS),
  }),
  buildTask({
    id: 'information_gap_analysis',
    title: 'Information gap analysis',
    description:
      "Real-question gap detection via seoAgent.js's analyzeInformationGaps(): normalizes and clusters caller-supplied question signals, classifies each question's evidence as observed/inferred/model_generated, analyzes competitor and current-site coverage, classifies the information gap, and scores the opportunity deterministically with stated reasons - composing agent/core/informationGapModel.js records via agent/core/informationGapEngine.js. A seo_analysis tool mode (researchParams.seoCapability). Identifies and prioritizes opportunities only; it never writes or publishes content.",
    toolIds: ['seo_analysis'],
    required: ['questions', 'questions[].question'],
    optional: [
      'questions[].questionType',
      'questions[].evidenceSources',
      'questions[].evidenceSources[].signalKind',
      'questions[].evidenceSources[].reference',
      'questions[].evidenceSources[].observedAt',
      'questions[].competitorObservations',
      'questions[].competitorObservations[].competitor',
      'questions[].competitorObservations[].covered',
      'questions[].competitorObservations[].answerQuality',
      'questions[].currentSiteCoverage',
      'questions[].businessRelevance',
      'questions[].customerUsefulness',
      'questions[].differentiationPotential',
      'questions[].demandSignal',
      'questions[].productContext',
      'questions[].recommendedTargetPage',
      'questions[].recommendedInternalLinks',
      'questions[].complianceAmbiguity',
      'topic',
      'market',
      'researchDate',
      'confidence',
      'recommendations',
      'verificationStatus',
    ],
    model: 'agent/core/seoAgentResultModel.js',
    fields: fieldIds(SEO_AGENT_RESULT_FIELDS),
  }),
];

// ---------------------------------------------------------------------------------
// Listing (agent/core/listingAgent.js)
// ---------------------------------------------------------------------------------

const LISTING_TASKS = [
  buildTask({
    id: 'listing_content',
    title: 'Listing content generation',
    description:
      "Compose one listingContentModel.js record (title, description, benefits, features, selling points, FAQs, attributes, variants, CTA) for one product via listingAgent.js's generateListingContent().",
    toolIds: ['listing_content_generation'],
    required: ['productReference'],
    optional: [
      'productTitle',
      'description',
      'benefits',
      'features',
      'sellingPoints',
      'faqs',
      'attributes',
      'variants',
      'cta',
      'evidence',
      'productInfo',
      'market',
      'targetMarket',
      'customerSegment',
      'seoRecommendations',
      'brandInfo',
    ],
    model: 'agent/core/listingAgentResultModel.js',
    fields: fieldIds(LISTING_AGENT_RESULT_FIELDS),
  }),
  buildTask({
    id: 'marketplace_format',
    title: 'Marketplace format',
    description:
      "Reformat one product listing to fit a named marketplace's constraints via listingAgent.js's formatForMarketplace() - deterministic truncation only.",
    toolIds: ['listing_content_generation'],
    required: ['marketplace', 'productReference'],
    optional: ['sourceListing', 'constraints', 'evidence'],
    model: 'agent/core/listingAgentResultModel.js',
    fields: fieldIds(LISTING_AGENT_RESULT_FIELDS),
  }),
];

// ---------------------------------------------------------------------------------
// Marketing (agent/core/marketingAgent.js)
// ---------------------------------------------------------------------------------

const MARKETING_ANALYSIS_OPTIONAL_FIELDS = [
  'campaign',
  'targetSegment',
  'product',
  'objective',
  'message',
  'offer',
  'timing',
  'evidence',
  'expectedOutcome',
  'verificationStatus',
];

const MARKETING_TASKS = [
  buildTask({
    id: 'marketing_strategy',
    title: 'Marketing strategy',
    description:
      "Compose one marketingAnalysisModel.js record for a named marketing channel via marketingAgent.js's analyzeMarketingStrategy() - the marketing_analysis tool's default mode (researchParams.marketingCapability).",
    toolIds: ['marketing_analysis'],
    required: ['marketingChannel'],
    optional: MARKETING_ANALYSIS_OPTIONAL_FIELDS,
    model: 'agent/core/marketingAgentResultModel.js',
    fields: fieldIds(MARKETING_AGENT_RESULT_FIELDS),
  }),
  buildTask({
    id: 'audience_segmentation',
    title: 'Audience segmentation',
    description:
      "Compose one customerSegmentResearchModel.js record per caller-supplied segment via marketingAgent.js's analyzeAudienceSegmentation(), delegating to researchAgent.js's retrieveResearchData/analyzeResearchData rather than rebuilding segmentation logic.",
    toolIds: ['marketing_analysis'],
    required: ['segments', 'segments[].segmentDefinition'],
    // No top-level `market` fallback or `researchDate` - analyzeAudienceSegmentation()
    // never reads params.market into each entry, and always calls todayIsoDate()
    // directly, verified against source.
    optional: [
      'segments[].needs',
      'segments[].problems',
      'segments[].buyingMotivations',
      'segments[].objections',
      'segments[].preferences',
      'segments[].market',
      'segments[].evidence',
      'segments[].confidence',
      'topic',
      'confidence',
      'recommendations',
      'verificationStatus',
    ],
    model: 'agent/core/marketingAgentResultModel.js',
    fields: fieldIds(MARKETING_AGENT_RESULT_FIELDS),
  }),
  buildTask({
    id: 'offers',
    title: 'Offers',
    description:
      "Compose one marketingAnalysisModel.js record for a caller-supplied offer via marketingAgent.js's analyzeOffers() - a marketing_analysis tool mode (researchParams.marketingCapability).",
    toolIds: ['marketing_analysis'],
    required: ['marketingChannel'],
    optional: MARKETING_ANALYSIS_OPTIONAL_FIELDS,
    model: 'agent/core/marketingAgentResultModel.js',
    fields: fieldIds(MARKETING_AGENT_RESULT_FIELDS),
  }),
  buildTask({
    id: 'promotions',
    title: 'Promotions',
    description:
      "Compose one marketingAnalysisModel.js record for a caller-supplied promotion via marketingAgent.js's analyzePromotions() - a marketing_analysis tool mode (researchParams.marketingCapability).",
    toolIds: ['marketing_analysis'],
    required: ['marketingChannel'],
    optional: MARKETING_ANALYSIS_OPTIONAL_FIELDS,
    model: 'agent/core/marketingAgentResultModel.js',
    fields: fieldIds(MARKETING_AGENT_RESULT_FIELDS),
  }),
  buildTask({
    id: 'retention',
    title: 'Retention',
    description:
      "Compose one growthOpportunityModel.js record pinned opportunityType 'retention' for one product via marketingAgent.js's analyzeRetention().",
    toolIds: ['marketing_analysis'],
    required: ['productReference'],
    optional: ['relatedProducts', 'targetSegment', 'offer', 'recommendation', 'evidence', 'verificationStatus'],
    model: 'agent/core/marketingAgentResultModel.js',
    fields: fieldIds(MARKETING_AGENT_RESULT_FIELDS),
  }),
  buildTask({
    id: 'campaign_planning',
    title: 'Campaign planning',
    description:
      "Compose one dedicated campaignPlanModel.js record (objective, audience, offer, message, channel, creative direction, CTA, KPIs, measurement plan) via marketingAgent.js's analyzeCampaignPlanning(), nested in the result's specialized_records.",
    toolIds: ['marketing_analysis'],
    required: ['campaignReference'],
    optional: [
      'objective',
      'audience',
      'offer',
      'message',
      'channel',
      'creativeDirection',
      'cta',
      'kpi',
      'measurementPlan',
      'evidence',
      'verificationStatus',
      'topic',
      'market',
      'confidence',
      'recommendations',
      'researchDate',
    ],
    model: 'agent/core/marketingAgentResultModel.js',
    fields: fieldIds(MARKETING_AGENT_RESULT_FIELDS),
  }),
  buildTask({
    id: 'email_strategy',
    title: 'Email strategy',
    description:
      "Compose one marketingAnalysisModel.js record via marketingAgent.js's analyzeEmailStrategy() - a marketing_analysis tool mode (researchParams.marketingCapability). marketingChannel is always pinned to 'email', never caller-supplied.",
    toolIds: ['marketing_analysis'],
    required: [],
    optional: MARKETING_ANALYSIS_OPTIONAL_FIELDS,
    model: 'agent/core/marketingAgentResultModel.js',
    fields: fieldIds(MARKETING_AGENT_RESULT_FIELDS),
  }),
  buildTask({
    id: 'conversion_opportunities',
    title: 'Conversion opportunities',
    description:
      "Compose one growthOpportunityModel.js record per caller-supplied opportunity entry (any opportunity type - upsell/cross-sell/retention/repeat-purchase/re-engagement) via marketingAgent.js's analyzeConversionOpportunities().",
    toolIds: ['marketing_analysis'],
    required: ['opportunities', 'opportunities[].productReference'],
    // No top-level `researchDate` - analyzeConversionOpportunities() always calls
    // todayIsoDate() directly, verified against source.
    optional: [
      'opportunities[].opportunityType',
      'opportunities[].relatedProducts',
      'opportunities[].targetSegment',
      'opportunities[].offer',
      'opportunities[].recommendation',
      'opportunities[].evidence',
      'opportunities[].verificationStatus',
      'topic',
      'market',
      'confidence',
      'recommendations',
      'verificationStatus',
    ],
    model: 'agent/core/marketingAgentResultModel.js',
    fields: fieldIds(MARKETING_AGENT_RESULT_FIELDS),
  }),
  buildTask({
    id: 'marketing_opportunity_ranking',
    title: 'Marketing opportunity ranking',
    description:
      "Rank caller-supplied opportunity candidates by evidence and business impact via marketingAgent.js's analyzeMarketingOpportunities() - agent/core/growthOpportunityEngine.js's rankGrowthOpportunities(), category pinned to 'marketing'. Never invents a candidate, evidence, or impact estimate; nothing not supplied is ever ranked. Answers 'what is my best opportunity' - only when real candidates are provided, not from a bare free-text objective alone.",
    toolIds: ['marketing_analysis'],
    required: [
      'candidates',
      'candidates[].opportunity',
      'candidates[].reason',
      'candidates[].requiredAction',
      'candidates[].expectedImpactCategory',
      'candidates[].expectedImpactMagnitude',
      'candidates[].actionClassification',
    ],
    optional: [
      'candidates[].evidence',
      'candidates[].confidence',
      'candidates[].verificationStatus',
      'topic',
      'market',
      'confidence',
      'recommendations',
      'verificationStatus',
      'researchDate',
    ],
    model: 'agent/core/marketingAgentResultModel.js',
    fields: fieldIds(MARKETING_AGENT_RESULT_FIELDS),
  }),
];

// ---------------------------------------------------------------------------------
// Social & Advertising (agent/core/socialAdvertisingAgent.js)
// ---------------------------------------------------------------------------------

const SOCIAL_PLATFORM_TASK_DEFS = [
  ['instagram', 'Instagram', 'analyzeInstagram'],
  ['facebook', 'Facebook', 'analyzeFacebook'],
  ['tiktok', 'TikTok', 'analyzeTiktok'],
  ['pinterest', 'Pinterest', 'analyzePinterest'],
  ['youtube', 'YouTube', 'analyzeYoutube'],
];

const AD_PLATFORM_TASK_DEFS = [
  ['meta_ads', 'Meta Ads', 'analyzeMetaAds'],
  ['google_ads', 'Google Ads', 'analyzeGoogleAds'],
  ['tiktok_ads', 'TikTok Ads', 'analyzeTiktokAds'],
];

const SOCIAL_ADVERTISING_TASKS = [
  ...SOCIAL_PLATFORM_TASK_DEFS.map(([id, label, fnName]) =>
    buildTask({
      id,
      title: `${label} content`,
      description: `Compose one socialContentModel.js record pinned to ${label}, for one caller-supplied content reference, via socialAdvertisingAgent.js's ${fnName}() - the social_content_planning tool's ${label} mode.`,
      toolIds: ['social_content_planning'],
      required: ['contentReference'],
      optional: ['contentType', 'objective', 'targetAudience', 'caption', 'hashtags', 'postingSchedule', 'evidence', 'expectedOutcome', 'verificationStatus'],
      model: 'agent/core/socialAdvertisingAgentResultModel.js',
      fields: fieldIds(SOCIAL_ADVERTISING_AGENT_RESULT_FIELDS),
    })
  ),
  ...AD_PLATFORM_TASK_DEFS.map(([id, label, fnName]) =>
    buildTask({
      id,
      title: `${label} campaign`,
      description: `Compose one adCampaignModel.js record pinned to ${label}, for one caller-supplied campaign reference, via socialAdvertisingAgent.js's ${fnName}() - the paid_advertising_planning tool's ${label} mode.`,
      toolIds: ['paid_advertising_planning'],
      required: ['campaignReference'],
      optional: ['objective', 'audience', 'budget', 'adCreative', 'biddingStrategy', 'cta', 'kpi', 'measurementPlan', 'evidence', 'verificationStatus'],
      model: 'agent/core/socialAdvertisingAgentResultModel.js',
      fields: fieldIds(SOCIAL_ADVERTISING_AGENT_RESULT_FIELDS),
    })
  ),
  buildTask({
    id: 'social_media_strategy',
    title: 'Social media strategy',
    description:
      "Compose one dedicated socialMediaStrategyModel.js record (content pillars, audience, platform selection, posting strategy, content themes, campaign themes, KPIs) via socialAdvertisingAgent.js's social_media_strategy capability.",
    toolIds: ['social_media_strategy_generation'],
    required: ['strategyReference'],
    optional: ['objective', 'audience', 'contentPillars', 'platformSelection', 'postingStrategy', 'contentThemes', 'campaignThemes', 'kpis', 'evidence', 'verificationStatus'],
    model: 'agent/core/socialAdvertisingAgentResultModel.js',
    fields: fieldIds(SOCIAL_ADVERTISING_AGENT_RESULT_FIELDS),
  }),
  buildTask({
    id: 'content_generation',
    title: 'Platform content generation',
    description:
      "Compose one dedicated platformContentModel.js record (hooks, captions, CTAs, content ideas, short-form video concepts, carousel concepts, creative briefs) adapted to one caller-specified platform via socialAdvertisingAgent.js's content_generation capability.",
    toolIds: ['platform_content_generation'],
    required: ['platform', 'contentReference'],
    optional: ['objective', 'targetAudience', 'hooks', 'captions', 'ctas', 'contentIdeas', 'shortFormVideoConcepts', 'carouselConcepts', 'creativeBriefs', 'platformAdaptationNotes', 'evidence', 'verificationStatus'],
    model: 'agent/core/socialAdvertisingAgentResultModel.js',
    fields: fieldIds(SOCIAL_ADVERTISING_AGENT_RESULT_FIELDS),
  }),
  buildTask({
    id: 'content_calendar',
    title: 'Content calendar',
    description:
      "Compose one contentCalendarModel.js entry (date, platform, content type, topic, hook, CTA, campaign, product, KPI) via socialAdvertisingAgent.js's content_calendar capability, optionally informed by Marketing Agent campaign context via marketingAgent.js's retrieveMarketingData('campaign_plan', ...).",
    toolIds: ['content_calendar_generation'],
    required: ['entryReference', 'date', 'platform'],
    optional: ['contentType', 'topic', 'hook', 'cta', 'campaign', 'product', 'kpi', 'evidence', 'verificationStatus', 'campaignContext'],
    model: 'agent/core/socialAdvertisingAgentResultModel.js',
    fields: fieldIds(SOCIAL_ADVERTISING_AGENT_RESULT_FIELDS),
  }),
  buildTask({
    id: 'advertising_strategy',
    title: 'Advertising strategy',
    description:
      "Compose one dedicated advertisingStrategyModel.js record (campaign objective, audience, offer, creative angle, ad copy, CTA, budget recommendation, KPI, testing plan) via socialAdvertisingAgent.js's advertising_strategy capability.",
    toolIds: ['advertising_strategy_planning'],
    required: ['strategyReference'],
    optional: ['campaignObjective', 'audience', 'offer', 'creativeAngle', 'adCopy', 'cta', 'budgetRecommendation', 'kpi', 'testingPlan', 'evidence', 'verificationStatus'],
    model: 'agent/core/socialAdvertisingAgentResultModel.js',
    fields: fieldIds(SOCIAL_ADVERTISING_AGENT_RESULT_FIELDS),
  }),
  buildTask({
    id: 'advertising_performance',
    title: 'Advertising performance',
    description:
      "Compose one dedicated advertisingPerformanceModel.js record (impressions, CTR, CPC, CPM, conversions, CPA, ROAS) via socialAdvertisingAgent.js's advertising_performance capability - actual_metrics is caller-supplied, calculated_metrics is derived from it via advertisingPerformanceCalculator.js, never fabricated.",
    toolIds: ['advertising_performance_analysis'],
    required: ['performanceReference'],
    optional: ['actualMetrics', 'evidence', 'verificationStatus'],
    model: 'agent/core/socialAdvertisingAgentResultModel.js',
    fields: fieldIds(SOCIAL_ADVERTISING_AGENT_RESULT_FIELDS),
  }),
];

// ---------------------------------------------------------------------------------
// Analytics & Optimization (agent/core/analyticsAgent.js, insightEngine.js)
// ---------------------------------------------------------------------------------

const ANALYTICS_SNAPSHOT_TASK_DEFS = [
  ['sales', 'Sales', 'sales'],
  ['products', 'Product performance', 'products'],
  ['customers', 'Customer behavior', 'customers'],
  ['conversion', 'Conversion', 'conversion'],
  ['traffic', 'Traffic', 'traffic'],
  ['marketing', 'Marketing performance', 'marketing'],
  ['advertising', 'Advertising performance', 'advertising'],
  ['inventory', 'Inventory', 'inventory'],
];

// analytics_data_retrieval (live, read-only Shopify pull) only covers 4 of the 8
// snapshot capabilities - the other 4 are analytics-tool-only (caller-supplied
// evidence). Verified directly against tools/analyticsDataTool.js's
// CAPABILITY_RETRIEVERS.
const ANALYTICS_DATA_RETRIEVAL_CAPABILITIES = ['sales', 'products', 'customers', 'inventory'];

const ANALYTICS_TASKS = [
  ...ANALYTICS_SNAPSHOT_TASK_DEFS.map(([id, label]) =>
    buildTask({
      id,
      title: `${label} snapshot`,
      description: `Compose the ${label.toLowerCase()} category of one agent/core/analyticsModel.js snapshot record from caller-supplied evidence via analyticsAgent.js's ${id} capability. No field is required - all optional, defaulting to empty/unverified.`,
      toolIds: ANALYTICS_DATA_RETRIEVAL_CAPABILITIES.includes(id)
        ? ['analytics', 'analytics_data_retrieval']
        : ['analytics'],
      liveDataToolId: ANALYTICS_DATA_RETRIEVAL_CAPABILITIES.includes(id) ? 'analytics_data_retrieval' : null,
      required: [],
      optional: ['summary', 'actualMetrics', 'calculatedMetrics', 'estimatedMetrics', 'verificationStatus'],
      model: 'agent/core/analyticsAgentResultModel.js',
      fields: fieldIds(ANALYTICS_AGENT_RESULT_FIELDS),
    })
  ),
  buildTask({
    id: 'growth_opportunities',
    title: 'Growth opportunities',
    description:
      "Compose one growthOpportunityModel.js record per caller-supplied opportunity entry via analyticsAgent.js's growth_opportunities capability.",
    toolIds: ['analytics'],
    required: ['opportunities'],
    // No top-level `researchDate` - analyzeGrowthOpportunities() always calls
    // todayIsoDate() directly, verified against source.
    optional: [
      'opportunities[].opportunityType',
      'opportunities[].relatedProducts',
      'opportunities[].targetSegment',
      'opportunities[].offer',
      'opportunities[].recommendation',
      'opportunities[].evidence',
      'opportunities[].verificationStatus',
      'topic',
      'market',
      'confidence',
      'recommendations',
      'verificationStatus',
    ],
    model: 'agent/core/analyticsAgentResultModel.js',
    fields: fieldIds(ANALYTICS_AGENT_RESULT_FIELDS),
  }),
  buildTask({
    id: 'insights',
    title: 'Insights',
    description:
      "Detect significant metric changes and compose one insightModel.js record per significant metric via analyticsAgent.js's insights capability, delegating significance detection to insightEngine.js's evaluateMetricSignificance() (never reimplemented). An unevidenced possible_cause is capped at medium confidence - a causation-honesty guard.",
    toolIds: ['analytics'],
    required: ['metrics', 'metrics[].metric'],
    // Deliberately excludes top-level `recommendations` - analyzeInsights() computes
    // it itself from the composed records (records.map(r => r.recommendation)) and
    // never reads params.recommendations; listing it as accepted input would be
    // dishonest (a caller-supplied value would be silently discarded), verified
    // against source.
    optional: [
      'metrics[].currentValue',
      'metrics[].comparisonValue',
      'metrics[].comparisonLabel',
      'metrics[].unit',
      'metrics[].currentState',
      'metrics[].comparison',
      'metrics[].possibleCause',
      'metrics[].opportunity',
      'metrics[].recommendation',
      'metrics[].evidence',
      'metrics[].confidence',
      'metrics[].verificationStatus',
      'topic',
      'market',
      'thresholdPercent',
      'confidence',
      'verificationStatus',
      'researchDate',
    ],
    model: 'agent/core/analyticsAgentResultModel.js',
    fields: fieldIds(ANALYTICS_AGENT_RESULT_FIELDS),
  }),
];

// ---------------------------------------------------------------------------------
// The registry itself - order matches agent/core/specialistRegistry.js exactly.
// ---------------------------------------------------------------------------------

const SPECIALIST_CAPABILITY_REGISTRY = [
  buildEntry('research', RESEARCH_TASKS),
  buildEntry('product', PRODUCT_TASKS),
  buildEntry('seo', SEO_TASKS),
  buildEntry('listing', LISTING_TASKS),
  buildEntry('marketing', MARKETING_TASKS),
  buildEntry('social_advertising', SOCIAL_ADVERTISING_TASKS),
  buildEntry('analytics_optimization', ANALYTICS_TASKS),
];

function getSpecialistCapabilityRegistry() {
  return SPECIALIST_CAPABILITY_REGISTRY;
}

function getSpecialistCapabilityById(id) {
  return SPECIALIST_CAPABILITY_REGISTRY.find((entry) => entry.id === id);
}

function getCapabilityTask(specialistId, capabilityId) {
  const entry = getSpecialistCapabilityById(specialistId);
  if (!entry) return undefined;
  return entry.supported_tasks.find((task) => task.id === capabilityId);
}

function getSpecialistCapabilityEntriesByStatus(status) {
  return SPECIALIST_CAPABILITY_REGISTRY.filter((entry) => entry.status === status);
}

module.exports = {
  PRODUCT_CAPABILITY_IDS,
  RESEARCH_CAPABILITY_IDS,
  SPECIALIST_CAPABILITY_REGISTRY,
  getSpecialistCapabilityRegistry,
  getSpecialistCapabilityById,
  getCapabilityTask,
  getSpecialistCapabilityEntriesByStatus,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - specialist capability registry (composition only):\n');
  for (const entry of SPECIALIST_CAPABILITY_REGISTRY) {
    console.log(`[${entry.id}] ${entry.title} (${entry.status})`);
    console.log(`  ${entry.supported_tasks.length} supported task(s), ${entry.required_tools.length} required tool(s): ${entry.required_tools.join(', ') || '(none)'}`);
    for (const task of entry.supported_tasks) {
      const toolNote = task.tool_ids.length > 0 ? task.tool_ids.join(', ') : '(no tool wired yet)';
      console.log(`    - ${task.id}: tools=[${toolNote}]`);
    }
  }
  console.log('\nEvery field above is reused or derived from agent/core/specialistRegistry.js, tools/toolRegistry.js,');
  console.log('agent/core/toolPermissions.js, and approvals/approvalArchitecture.js - nothing here is a separate source of truth.');
}
