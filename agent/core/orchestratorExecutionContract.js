'use strict';

// The Chief/Orchestrator's execution contract: a real, callable implementation of
// agent/core/agentContract.js's lifecycle stages - receive -> normalize -> identify
// capability -> detect missing info -> build execution request -> select specialist
// -> pass minimum context -> receive specialist result -> validate -> respond.
//
// Deterministic only - no AI/Claude API call is made here. agentContract.js's own
// header reserves "no AI API calls" for a later, explicitly-scoped prompt, so
// capability identification is plain keyword matching against the existing
// tools/toolRegistry.js and agent/core/specialistCapabilityRegistry.js entries.
//
// STRUCTURED ROUTING: a single objective can require more than one of the 7 approved
// specialists. Routing happens at the specialist level first (ROUTING_TARGETS, built
// from agent/core/specialistCapabilityRegistry.js + the shared-infrastructure tool
// categories), producing a controlled, ordered execution plan rather than a single
// silent pick - and when a request is genuinely ambiguous (two or more targets tie for
// the best match), routing stops and reports a clarification requirement instead of
// guessing. See planRouting()/routeClause() below. Every existing single-capability
// function (understandObjective, identifyRequiredCapability, needsMoreInformation,
// createExecutionRequest, selectSpecialist, gatherMinimumContext,
// executeSelectedCapability, validateResult) is reused unchanged - the plan is built
// by calling them once per routed target, not by reimplementing their logic.
//
// THE FULL PIPELINE THIS FILE IMPLEMENTS, per request:
//   User Request -> Chief (planRouting: split into clauses, route each one, stop for
//   clarification on anything ambiguous/unmatched) -> Specialist (buildPlanStep: the
//   matched agent/core/specialistCapabilityRegistry.js entry supplies the specialist's
//   required_tools and, once a tool is matched, which declared capability/task it
//   serves) -> Tool(s) (executeSelectedCapability: the ONLY place a tool executor is
//   ever invoked, gated by agent/core/toolPermissions.js's checkToolAccess() - see
//   TOOL_EXECUTORS below) -> Result (validateResult + deriveExecutionState, one
//   self-contained state per step) -> Chief (buildRoutingResponse aggregates every
//   step's state into the final response) -> User.
//
// NO UNCONTROLLED SPECIALIST-TO-SPECIALIST EXECUTION: TOOL_EXECUTORS is the single
// dispatch surface in this entire codebase - no agent/core/*Agent.js file requires
// a tools/*.js module or this file, so nothing outside this pipeline can ever invoke a
// tool. Where one specialist's module reuses another's pure, side-effect-free data
// composition helper (agent/core/researchAgent.js's generic record builders, reused by
// every specialist per established convention; agent/core/socialAdvertisingAgent.js's
// content_calendar capability optionally reading agent/core/marketingAgent.js's
// retrieveMarketingData for campaign context), that is read-only schema composition,
// never a tool call - it does not touch TOOL_EXECUTORS, does not bypass
// checkToolAccess, and never executes an action on another specialist's behalf.
//
// No autonomous or write-capable external action - every implemented tool today is
// classified 'analysis_only' or 'recommendation' in agent/core/toolPermissions.js's
// TOOL_CLASSIFICATIONS (see approvals/approvalArchitecture.js). Anything
// approval_required/externally_executable stops and reports that instead of executing.
//
// No new persistence - the returned state is a stateModel.js-shaped object built
// in-memory and returned to the caller; it is never written to memory/state/ (no
// storage mechanism has been chosen yet).

const fs = require('fs');
const path = require('path');
const { TOOL_REGISTRY, getToolsByCategory, getToolById } = require('../../tools/toolRegistry');
const { loadBusinessConfig, readEnabledPlatforms } = require('../../tools/configValidator');
const { readDailyContentUnitsTarget } = require('./contentCadencePolicy');
const { getSpecialistById } = require('./specialistRegistry');
const { getSpecialistCapabilityRegistry, getSpecialistCapabilityById } = require('./specialistCapabilityRegistry');
const {
  deriveCrossAgentContext,
  deriveAllToAnalyticsContext,
  deriveLiveEvidenceContext,
  findLiveEvidenceProvider,
  gatherGrowthOpportunityDrafts,
  mergeContext,
  dedupeArray,
} = require('./crossAgentContext');
const { getContextBoundaries } = require('./contextBoundaries');
const { createEmptyState } = require('./stateModel');
const { deriveExecutionState, getToolResultStatus } = require('./executionState');
const {
  CATEGORY_TO_SPECIALIST,
  SPECIALIST_TO_CATEGORIES,
  SHARED_INFRASTRUCTURE_CATEGORIES,
  checkToolAccess,
} = require('./toolPermissions');
const { createApprovalRequest } = require('../../approvals/approvalWorkflow');
const { createAuditTracker, appendAuditEvent } = require('../../audit/auditTrail');
const { createToolResultCache, getCachedResult, setCachedResult } = require('./toolResultCache');
const { checkArrayFieldBounds, checkPlanStepBounds } = require('./executionBounds');
const { createUsageTracker, checkUsageLimits, recordUsage, MODEL_CALL_TOOL_IDS, EXTERNAL_API_TOOL_IDS, RESEARCH_TOOL_IDS } = require('./usageLimits');
const { createUsageLedger, appendUsageEvent, summarizeUsage } = require('../../usage/usageTracker');
const { isValidBusinessId, getEnabledPlatforms } = require('../../configuration/businessRegistry');
const {
  isCorrectionTool,
  requiresSourceProposal,
  verifyCorrectionSource,
  checkCorrectionAlreadyVerified,
  buildCorrectionComplianceInput,
  executeApprovedCorrection,
} = require('../../integrations/approvedCorrectionDispatch');
// The real compliance engine, used ONLY to compute a correction's verdict from its own
// described action at approval time and to summarise it for the approver - see the
// approval_required branch below. No verdict is ever accepted from a caller, and the same
// engine is re-run independently at execution time by
// approvals/complianceApprovalGate.js's verifyComplianceForApprovalRequest.
const { evaluateCompliance, summarizeComplianceForApproval } = require('../../compliance/complianceEngine');
// THE MUTATION-INTENT GATE (agent/core/mutationIntent.js). One definition of "does this
// request actually ask to change something", consulted at every point below where a
// mutation tool could be selected or dispatched. See that module's header for the real
// production-validation defect it closes and why word-overlap scoring cannot close it.
const {
  filterToolCandidatesByIntent,
  maySelectMutationTool,
  classifyRequestIntent,
  hasExplicitMutationIntent,
  mutationIntentRefusalReason,
} = require('./mutationIntent');
// What each clause of an objective ASKS FOR - see agent/core/objectiveInterpretation.js and
// resolveObjectiveIntent below.
const {
  tokens: interpretationTokens,
  singularForm,
  isInstructionWord,
  refersBack,
  collectSafetyConstraints,
  isConnectedPlatformName,
  connectedPlatformNamesIn,
  interpretClause,
  unrelatedNounPhrase,
  endsInPrepositionalPhrase,
} = require('./objectiveInterpretation');
// The Memory layer's own connection into this run flow (agent/core/memoryStore.js's
// business-isolated storage + agent/core/memoryRecordModel.js's verified/approved
// gate) - see agent/core/memoryContextRetrieval.js's own header for the full scope
// this wiring is (and is deliberately not) responsible for.
const { getRelevantMemoryContext, persistVerifiedFinding } = require('./memoryContextRetrieval');
// RESEARCH CONTINUITY: whether an objective continues completed research (researchContext.js),
// the read-only research basis it stands on, and the ranked answer built from that basis.
const { decideResearchContinuity, routedTargetNeedsOwnStep } = require('./researchContext');
const { STORE_RESEARCH_BASIS, prioritizeStoreOpportunities } = require('./storeOpportunityPrioritization');
// A change PROPOSAL built on that research - before/after values held for human approval.
const { proposeSeoChanges, PROPOSAL_TOOL_ID, PROPOSAL_SPECIALIST_ID } = require('./seoChangeProposal');
// Applying such a proposal once it exists - resolved against durable approval state, never re-worded.
const {
  decideProposalCheck,
  decideProposalExecution,
  referencesExistingProposal,
  resolveProposalExecution,
  resolveProposalResearchBasis,
  APPLICATION_TOOL_ID: PROPOSAL_APPLICATION_TOOL_ID,
} = require('./proposalExecution');
// One honest, compact sentence per finished execution state (agent/core/resultSummary.js) -
// reused unchanged as the memory record's own `summary` (memoryRules.js's "compact"
// quality) rather than inventing a second summarization path.
const { summarizeExecutionState } = require('./resultSummary');
const businessConfigurationRetrieval = require('../../tools/businessConfigurationRetrieval');
const aiReasoningCompletion = require('../../tools/aiReasoningCompletion');
const marketResearchTool = require('../../tools/marketResearchTool');
const researchAnalysisTool = require('../../tools/researchAnalysisTool');
const competitorResearchTool = require('../../tools/competitorResearchTool');
const webCompetitorResearchTool = require('../../tools/webCompetitorResearchTool');
const marketQuestionDiscoveryTool = require('../../tools/marketQuestionDiscoveryTool');
const seoContentGenerationTool = require('../../tools/seoContentGenerationTool');
const complianceCheckTool = require('../../tools/complianceCheckTool');
const customerResearchTool = require('../../tools/customerResearchTool');
const globalMarketOpportunityTool = require('../../tools/globalMarketOpportunityTool');
const marketProductOpportunityTool = require('../../tools/marketProductOpportunityTool');
const keywordResearchTool = require('../../tools/keywordResearchTool');
const seoAnalysisTool = require('../../tools/seoAnalysisTool');
const listingContentTool = require('../../tools/listingContentTool');
const marketingAnalysisTool = require('../../tools/marketingAnalysisTool');
const offerRecommendationTool = require('../../tools/offerRecommendationTool');
const socialContentTool = require('../../tools/socialContentTool');
const paidAdvertisingTool = require('../../tools/paidAdvertisingTool');
const socialMediaStrategyTool = require('../../tools/socialMediaStrategyTool');
const platformContentTool = require('../../tools/platformContentTool');
const contentCalendarTool = require('../../tools/contentCalendarTool');
const advertisingStrategyTool = require('../../tools/advertisingStrategyTool');
const advertisingPerformanceTool = require('../../tools/advertisingPerformanceTool');
const analyticsTool = require('../../tools/analyticsTool');
const analyticsDataTool = require('../../tools/analyticsDataTool');
const productDataRetrievalTool = require('../../tools/productDataRetrievalTool');
const productResearchTool = require('../../tools/productResearchTool');
const collectionDataRetrievalTool = require('../../tools/collectionDataRetrievalTool');
const customerMarketOpportunityTool = require('../../tools/customerMarketOpportunityTool');
// What a research request asks for: the markets it names, live market research intent, and named data
// sources this system has no integration for (agent/core/researchRequestIntent.js).
const {
  detectMarketNames,
  isMarketWord,
  isMarketListFragment,
  unsupportedDataSourceIn,
  unsupportedDataSourceAlternative,
  hasLiveMarketResearchIntent,
} = require('./researchRequestIntent');
const { hasEconomicsIntent } = require('./productEconomics');
const researchUsageGuard = require('./researchUsageGuard');
const vendorCorrection = require('./vendorCorrectionRequest');
const { currentStoreReference } = require('./researchContext');
const etsyShopDataTool = require('../../tools/etsyShopDataTool');
const etsyListingDataTool = require('../../tools/etsyListingDataTool');
const seoQualityCheckTool = require('../../tools/seoQualityCheckTool');
const listingQualityCheckTool = require('../../tools/listingQualityCheckTool');

// WHICH ETSY LISTING STATE AN OBJECTIVE ASKS FOR.
//
// Etsy's getListingsByShop takes a `state` query parameter. 'active' is the only value wired
// here, because asking for the live catalogue is the only thing any request has asked for -
// and because it is a value Etsy itself defines, not one composed here. An objective that names
// no state sends none, and Etsy's own default applies unchanged; an objective naming some other
// state is NOT mapped to a guess, it simply sends nothing.
//
// Matched on the word beside a listing/catalogue noun rather than anywhere in the text, so
// "active" in an unrelated sentence cannot silently narrow a catalogue read.
const ETSY_ACTIVE_LISTING_PATTERN = /\bactive\b[\w\s-]{0,24}?\b(listing|listings|catalogue|catalog|products?|items?)\b/i;

function etsyListingStateFilter(objective) {
  return ETSY_ACTIVE_LISTING_PATTERN.test(String(objective || '')) ? 'active' : null;
}

// Tool ids this orchestrator knows how to actually call. Each entry maps a
// TOOL_REGISTRY id to the real function that performs the work - the only sanctioned
// way execution happens, never a generic/dynamic call. Which tool is required is
// decided by routing (planRouting/buildPlanStep below); whether it's available,
// permitted for the requesting specialist, and whether it needs approval is decided
// exclusively by agent/core/toolPermissions.js's checkToolAccess() - this map is only
// consulted after that gate has already said 'allowed'.
//
// Every executor receives (executionRequest, runTokenTracker). Most ignore both
// (business_configuration_retrieval takes no input); ai_reasoning_completion uses
// executionRequest.objective as its instruction and runTokenTracker to enforce this
// run's token budget (agent/core/tokenControls.js) - see executeSelectedCapability
// and buildPlanStep below for where runTokenTracker is created and updated. The
// research and SEO tools read executionRequest.research_params instead - an optional
// structured passthrough (see createExecutionRequest/buildPlanStep/
// runOrchestratorContract below) - since free-text objective text alone cannot supply
// the structured evidence these tools require; each tool itself reports honestly
// (never fabricates) when research_params is absent. See tools/marketResearchTool.js,
// tools/competitorResearchTool.js, tools/customerResearchTool.js,
// tools/keywordResearchTool.js, tools/seoAnalysisTool.js.
const TOOL_EXECUTORS = {
  business_configuration_retrieval: (executionRequest) =>
    businessConfigurationRetrieval.retrieveBusinessConfiguration({ businessId: executionRequest.business_id }),
  ai_reasoning_completion: (executionRequest, runTokenTracker) =>
    aiReasoningCompletion.runReasoningCompletion({
      instruction: executionRequest.objective,
      tokensUsedThisRun: runTokenTracker.tokensUsedThisRun,
      businessId: executionRequest.business_id,
    }),
  market_research: (executionRequest) =>
    marketResearchTool.runMarketResearchTool(executionRequest.research_params),
  competitor_research: (executionRequest) =>
    competitorResearchTool.runCompetitorResearchTool(executionRequest.research_params),
  // The Research specialist's LIVE counterpart to competitor_research (see
  // agent/core/specialistCapabilityRegistry.js's competitor_research task and the
  // "LIVE WEB COMPETITOR RESEARCH" block in buildPlanStep below) - reads the free-text
  // objective itself (a real Claude + web_search call), not research_params, the same
  // way ai_reasoning_completion does above - including sharing this run's token
  // budget via runTokenTracker.
  live_competitor_research: (executionRequest, runTokenTracker) =>
    webCompetitorResearchTool.runWebCompetitorResearchTool({
      objective: executionRequest.objective,
      businessId: executionRequest.business_id,
      tokensUsedThisRun: runTokenTracker.tokensUsedThisRun,
    }),
  // The evidence-acquisition layer upstream of the SEO specialist's
  // information_gap_analysis capability - like live_competitor_research above, a real
  // Claude + web_search call sharing this run's token budget via runTokenTracker.
  // Takes its topic seed from research_params where a caller supplied one, falling back
  // to the free-text objective, so it works both from a structured plan step and from a
  // plain objective without either path guessing the other's input.
  discover_market_questions: (executionRequest, runTokenTracker) =>
    marketQuestionDiscoveryTool.runMarketQuestionDiscoveryTool({
      topic:
        (executionRequest.research_params && executionRequest.research_params.topic) ||
        executionRequest.objective,
      market: (executionRequest.research_params && executionRequest.research_params.market) || '',
      limit: executionRequest.research_params && executionRequest.research_params.limit,
      businessId: executionRequest.business_id,
      tokensUsedThisRun: runTokenTracker.tokensUsedThisRun,
    }),
  // The stage after the Information Gap Finder: a validated opportunity becomes a brief
  // and (only when the evidence justifies it) a draft. Spends model tokens through
  // tools/aiReasoningCompletion.js, so this run's running total is threaded in exactly
  // like every other model-calling tool - a blocked or review opportunity makes no call
  // at all and spends nothing.
  seo_content_generation: (executionRequest, runTokenTracker) =>
    seoContentGenerationTool.runSeoContentGenerationTool({
      ...(executionRequest.research_params || {}),
      businessId: executionRequest.business_id,
      tokensUsedThisRun: runTokenTracker.tokensUsedThisRun,
    }),
  // The shared-core Compliance stage, between content generation and human approval.
  // Deterministic and free by default (no model call at all); its optional AI-assisted
  // ambiguity pass goes through tools/aiReasoningCompletion.js, so this run's running
  // token total is threaded in exactly like every other model-capable tool. Owned by no
  // specialist - it is only ever reachable here, under checkToolAccess().
  compliance_check: (executionRequest, runTokenTracker) =>
    complianceCheckTool.runComplianceCheckTool({
      ...(executionRequest.research_params || {}),
      businessId: executionRequest.business_id,
      tokensUsedThisRun: runTokenTracker.tokensUsedThisRun,
    }),
  research_analysis: (executionRequest) =>
    researchAnalysisTool.runResearchAnalysisTool(executionRequest.research_params),
  customer_research: (executionRequest) =>
    customerResearchTool.runCustomerResearchTool(executionRequest.research_params),
  global_market_opportunity_analysis: (executionRequest) =>
    globalMarketOpportunityTool.runGlobalMarketOpportunityTool(executionRequest.research_params),
  market_product_opportunity_analysis: (executionRequest) =>
    marketProductOpportunityTool.runMarketProductOpportunityTool(executionRequest.research_params),
  keyword_research: (executionRequest) =>
    keywordResearchTool.runKeywordResearchTool(executionRequest.research_params),
  seo_analysis: (executionRequest) =>
    seoAnalysisTool.runSeoAnalysisTool(executionRequest.research_params),
  listing_content_generation: (executionRequest) =>
    listingContentTool.runListingContentTool(executionRequest.research_params),
  marketing_analysis: (executionRequest) =>
    marketingAnalysisTool.runMarketingAnalysisTool(executionRequest.research_params),
  // No businessId spread: like marketing_analysis above, this tool reaches no external
  // system - it only audits what the caller already supplied. It also needs no
  // TOOL_CAPABILITY_SELECTORS entry, because it serves exactly one capability
  // (offer_recommendation), so there is no mode for the orchestrator to select.
  offer_recommendation: (executionRequest) =>
    offerRecommendationTool.runOfferRecommendationTool(executionRequest.research_params),
  social_content_planning: (executionRequest) =>
    socialContentTool.runSocialContentTool(executionRequest.research_params),
  paid_advertising_planning: (executionRequest) =>
    paidAdvertisingTool.runPaidAdvertisingTool(executionRequest.research_params),
  social_media_strategy_generation: (executionRequest) =>
    socialMediaStrategyTool.runSocialMediaStrategyTool(executionRequest.research_params),
  platform_content_generation: (executionRequest) =>
    platformContentTool.runPlatformContentTool(executionRequest.research_params),
  content_calendar_generation: (executionRequest) =>
    contentCalendarTool.runContentCalendarTool(executionRequest.research_params),
  advertising_strategy_planning: (executionRequest) =>
    advertisingStrategyTool.runAdvertisingStrategyTool(executionRequest.research_params),
  advertising_performance_analysis: (executionRequest) =>
    advertisingPerformanceTool.runAdvertisingPerformanceTool(executionRequest.research_params),
  analytics: (executionRequest) =>
    analyticsTool.runAnalyticsTool(executionRequest.research_params),
  analytics_data_retrieval: (executionRequest) =>
    analyticsDataTool.runAnalyticsDataTool({
      ...(executionRequest.research_params || {}),
      businessId: executionRequest.business_id,
    }),
  product_data_retrieval: (executionRequest) =>
    productDataRetrievalTool.runProductDataRetrievalTool({
      // A request about profit, margin or cost also reads recorded unit costs (see tools/productDataRetrievalTool.js).
      unitEconomics: hasEconomicsIntent(executionRequest.objective),
      ...(executionRequest.research_params || {}),
      businessId: executionRequest.business_id,
    }),
  collection_data_retrieval: (executionRequest) =>
    collectionDataRetrievalTool.retrieveCollectionData({
      ...(executionRequest.research_params || {}),
      businessId: executionRequest.business_id,
    }),
  // Customer-related global market opportunity research. Takes runTokenTracker for the
  // same reason live_competitor_research above does: it makes real Claude + web_search
  // calls, and threading this run's running total in means its batched calls share the ONE
  // per-run token budget instead of opening a second one.
  catalogue_expansion_opportunities: (executionRequest, runTokenTracker) =>
    customerMarketOpportunityTool.runCustomerMarketOpportunityTool({
      // The markets the request itself names scope the research, unless the caller supplied them explicitly.
      markets: detectMarketNames(executionRequest.objective),
      ...(executionRequest.research_params || {}),
      businessId: executionRequest.business_id,
      tokensUsedThisRun: runTokenTracker.tokensUsedThisRun,
    }),
  // The two Etsy reads. Same businessId spread as the Shopify pulls above because they
  // too reach a real external system - and, like them, they only ever GET: the Etsy read
  // client (integrations/adapters/etsyReadClient.js) has no write path, and the Etsy
  // publish adapter is not referenced from either tool.
  etsy_shop_data_retrieval: (executionRequest) =>
    etsyShopDataTool.runEtsyShopDataTool({
      ...(executionRequest.research_params || {}),
      businessId: executionRequest.business_id,
    }),
  etsy_listing_data_retrieval: (executionRequest) =>
    etsyListingDataTool.runEtsyListingDataTool({
      // A request about the ACTIVE catalogue asks Etsy for that state rather than filtering
      // afterwards, so the page this run reads is the live catalogue and not the first 25 of
      // everything. Only a state Etsy itself defines is ever sent (see etsyListingStateFilter);
      // an objective naming none sends nothing and Etsy's own default applies. The caller's own
      // explicit `state` always wins, exactly like every other research_params field.
      state: etsyListingStateFilter(executionRequest.objective),
      ...(executionRequest.research_params || {}),
      businessId: executionRequest.business_id,
    }),
  // No businessId spread: unlike the two live Shopify pulls above, this tool reaches no
  // external system - it only composes what the caller already supplied, exactly like
  // research_analysis and analytics above.
  product_research: (executionRequest) =>
    productResearchTool.runProductResearchTool(executionRequest.research_params),
  // No businessId spread: like offer_recommendation above, these tools reach no
  // external system - they only audit what the caller already supplied. Neither needs
  // a TOOL_CAPABILITY_SELECTORS entry either, for the same reason: each serves exactly
  // one capability (seo_quality_check / listing_quality_check), so there is no mode
  // for the orchestrator to select.
  seo_quality_check: (executionRequest) =>
    seoQualityCheckTool.runSeoQualityCheckTool(executionRequest.research_params),
  listing_quality_check: (executionRequest) =>
    listingQualityCheckTool.runListingQualityCheckTool(executionRequest.research_params),
};

const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'for', 'to', 'and', 'or', 'is', 'are', 'my', 'me', 'i',
  'in', 'on', 'about', 'please', 'can', 'you', 'what', 'get', 'give',
]);

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

// Receive + normalize the task. Throws a clear error for missing/invalid input -
// never guesses an objective from nothing.
function understandObjective(rawTask) {
  if (typeof rawTask !== 'string' || rawTask.trim() === '') {
    throw new Error('understandObjective requires a non-empty task string.');
  }
  return rawTask.trim().replace(/\s+/g, ' ');
}

// Identify the required capability: deterministic word-overlap match against
// tools/toolRegistry.js's existing entries - no external call, no invented category.
// Kept for single-tool lookups and backward compatibility; structured, multi-target
// routing below (planRouting) is what runOrchestratorContract actually uses now.
function identifyRequiredCapability(objective) {
  const objectiveWords = new Set(tokenize(objective));
  if (objectiveWords.size === 0) {
    return null;
  }

  // GATE 1 OF 3: a mutation tool is not even a CANDIDATE unless this objective states an
  // explicit instruction to change something. Without this, the correction tools' own
  // nouns ("vendor", "inventory", "product", "shopify") let them outscore the read tool
  // for a plainly read-only request - the measured defect in mutationIntent.js's header.
  // Non-mutation tools are untouched, so every other objective scores exactly as before.
  const selectableTools = maySelectMutationTool(objective)
    ? TOOL_REGISTRY
    : TOOL_REGISTRY.filter((tool) => !isCorrectionTool(tool.id));

  let best = null;
  let bestScore = 0;
  for (const tool of selectableTools) {
    const toolWords = tokenize(`${tool.id} ${tool.title} ${tool.description} ${tool.category}`);
    let score = 0;
    for (const word of toolWords) {
      if (objectiveWords.has(word)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = tool;
    }
  }

  if (!best || bestScore === 0) {
    return null;
  }
  return { category: best.category, tool: best };
}

// Determine whether more information is required before proceeding.
function needsMoreInformation(objective, capability) {
  if (!objective || objective.length < 4) {
    return { needs_more_information: true, reason: 'The task is too short to act on.' };
  }
  if (!capability) {
    return {
      needs_more_information: true,
      reason: 'No known capability matches this task - please clarify what you need.',
    };
  }
  return { needs_more_information: false, reason: null };
}

// Create a structured execution request from the identified capability. researchParams
// is an optional structured passthrough (see runOrchestratorContract/buildPlanStep
// below) - attached as-is (null when absent) for whichever tool executor ends up
// selected; a tool that doesn't use it (e.g. business_configuration_retrieval) simply
// ignores the field.
function createExecutionRequest(objective, capability, researchParams = null, businessId = null) {
  const category = capability.category;
  const specialistId = CATEGORY_TO_SPECIALIST[category] || null;
  return {
    objective,
    category,
    tool_id: capability.tool.id,
    specialist_id: specialistId,
    is_shared_infrastructure: specialistId === null,
    research_params: researchParams,
    business_id: businessId,
  };
}

// Select the correct specialist for the request, or shared infrastructure when the
// category isn't owned by any of the 7 specialists.
function selectSpecialist(executionRequest) {
  if (executionRequest.is_shared_infrastructure) {
    return { type: 'shared_infrastructure', id: null, status: null };
  }
  const specialist = getSpecialistById(executionRequest.specialist_id);
  if (!specialist) {
    return { type: 'unknown', id: executionRequest.specialist_id, status: null };
  }
  return { type: 'specialist', id: specialist.id, status: specialist.status };
}

// Pass minimum required context: only the boundary entries relevant to this
// request's category, never the full boundary list.
function gatherMinimumContext(executionRequest) {
  const boundaries = getContextBoundaries();
  const relevantIds = ['tool_context'];
  if (executionRequest.category === 'configuration') relevantIds.push('business_context');
  if (executionRequest.category === 'products') relevantIds.push('product_context');
  if (['research', 'customer_market_intelligence'].includes(executionRequest.category)) {
    relevantIds.push('research_context');
  }
  if (executionRequest.category === 'memory') relevantIds.push('memory_context');

  return boundaries.filter((boundary) => relevantIds.includes(boundary.id));
}

// Tools whose result is never safe to cache/reuse from an earlier identical call in
// this same run. ai_reasoning_completion is the one non-deterministic tool in
// TOOL_EXECUTORS (a real Claude call) - its output is not a pure function of its
// input the way every other tool's is, even though it could technically be keyed by
// the objective text it receives. An explicit exclusion here is more honest and
// auditable than relying on incidental key uniqueness. live_competitor_research is the
// same shape for the same reason (a real Claude + web_search call keyed by objective
// text, not research_params).
const NEVER_CACHED_TOOL_IDS = new Set(['ai_reasoning_completion', 'live_competitor_research']);

// Shared executor-invocation tail for both executeSelectedCapability (first attempt)
// and resumeApprovedExecution (post-approval retry) - the only two places TOOL_EXECUTORS
// is ever read, so a tool call always looks the same regardless of which path reached
// it. Never fabricates a result: a missing executor or a thrown error both become an
// explicit, honest 'error' outcome.
//
// runToolResultCache (see agent/core/toolResultCache.js), when supplied, memoizes an
// identical (same toolId + same research_params) prior successful call within this
// same run - "reduce repeated tool results". A cache hit appends one lightweight
// audit event instead of the usual 4-event burst below, and returns the cached
// outcome without re-invoking the executor. Error outcomes are never cached (a
// failure may legitimately succeed on retry if caused by something outside the pure
// params, e.g. missing env config fixed mid-run).
//
// runUsageTracker (see agent/core/usageLimits.js), when supplied, enforces this
// run's configurable tool/model/research/external-API call ceilings - checked only
// on the real (cache-miss) dispatch path below, right before the executor is
// invoked, so a cache hit never consumes budget. A breach returns a controlled
// error outcome instead of executing, exactly like the cache-miss executor-error
// path already does.
async function runExecutor(toolId, executionRequest, runTokenTracker, classification, runAuditTracker = null, runToolResultCache = null, runUsageTracker = null, runUsageLedger = null) {
  const executor = TOOL_EXECUTORS[toolId];
  if (!executor) {
    appendAuditEvent(runAuditTracker, {
      type: 'error',
      toolId,
      specialistId: executionRequest ? executionRequest.specialist_id : null,
      classification,
      status: 'error',
      summary: `No executor is wired for implemented tool '${toolId}'.`,
    });
    return {
      status: 'error',
      data: null,
      error: `No executor is wired for implemented tool '${toolId}'.`,
      classification,
    };
  }

  const specialistId = executionRequest ? executionRequest.specialist_id : null;
  const researchParams = executionRequest ? executionRequest.research_params : null;
  const cacheEligible = runToolResultCache && !NEVER_CACHED_TOOL_IDS.has(toolId);

  if (cacheEligible) {
    const cached = getCachedResult(runToolResultCache, toolId, researchParams);
    if (cached !== undefined) {
      appendAuditEvent(runAuditTracker, {
        type: 'result',
        toolId,
        specialistId,
        classification,
        status: 'cache_hit',
        summary: `Tool '${toolId}' result reused from this run's cache (identical prior call).`,
      });
      return cached;
    }
  }

  if (runUsageTracker) {
    const usageCheck = checkUsageLimits(toolId, runUsageTracker);
    if (!usageCheck.allowed) {
      appendAuditEvent(runAuditTracker, {
        type: 'error',
        toolId,
        specialistId,
        classification,
        status: 'error',
        summary: usageCheck.reason,
      });
      appendUsageEvent(runUsageLedger, {
        category: MODEL_CALL_TOOL_IDS.has(toolId) ? 'model_call' : 'tool_call',
        specialistId,
        toolId,
        status: 'error',
        isExternalApi: EXTERNAL_API_TOOL_IDS.has(toolId),
        isResearch: RESEARCH_TOOL_IDS.has(toolId),
        quantity: 0,
        summary: usageCheck.reason,
      });
      return { status: 'error', data: null, error: usageCheck.reason, classification };
    }
    recordUsage(toolId, runUsageTracker);
  }

  appendAuditEvent(runAuditTracker, {
    type: 'tools',
    toolId,
    specialistId,
    classification,
    summary: `Invoking tool '${toolId}'.`,
  });
  appendAuditEvent(runAuditTracker, {
    type: 'data_access',
    toolId,
    specialistId,
    summary: `Tool '${toolId}' was passed its request data.`,
    detail: { fields: Object.keys((executionRequest && executionRequest.research_params) || {}) },
  });
  appendAuditEvent(runAuditTracker, {
    type: 'execution',
    toolId,
    specialistId,
    classification,
    summary: `Executing tool '${toolId}'.`,
  });

  try {
    // Every research provider call inside the tool - fallbacks included - is checked and counted against this run
    // and business (agent/core/researchUsageGuard.js).
    const data = await researchUsageGuard.runWithResearchUsageContext(
      { businessId: executionRequest ? executionRequest.business_id : null, usageTracker: runUsageTracker },
      () => executor(executionRequest, runTokenTracker)
    );
    appendAuditEvent(runAuditTracker, {
      type: 'result',
      toolId,
      specialistId,
      classification,
      status: 'success',
      summary: `Tool '${toolId}' completed successfully.`,
    });
    const isModelCall = MODEL_CALL_TOOL_IDS.has(toolId);
    const tokens =
      isModelCall && data && typeof data.inputTokens === 'number' && typeof data.outputTokens === 'number'
        ? { input: data.inputTokens, output: data.outputTokens, total: data.inputTokens + data.outputTokens }
        : null;
    appendUsageEvent(runUsageLedger, {
      category: isModelCall ? 'model_call' : 'tool_call',
      specialistId,
      toolId,
      status: 'success',
      isExternalApi: EXTERNAL_API_TOOL_IDS.has(toolId),
      isResearch: RESEARCH_TOOL_IDS.has(toolId),
      tokens,
      model: isModelCall && data ? data.model || null : null,
      quantity: tokens ? tokens.total : 1,
      summary: `Tool '${toolId}' completed successfully.`,
    });
    if (classification === 'recommendation') {
      appendAuditEvent(runAuditTracker, {
        type: 'recommendation',
        toolId,
        specialistId,
        classification,
        summary: `Tool '${toolId}' produced a recommendation-classified result.`,
      });
    }
    if (cacheEligible) {
      setCachedResult(runToolResultCache, toolId, researchParams, { status: 'success', data, error: null, classification });
    }
    return { status: 'success', data, error: null, classification };
  } catch (err) {
    appendAuditEvent(runAuditTracker, {
      type: 'error',
      toolId,
      specialistId,
      classification,
      status: 'error',
      summary: err.message,
    });
    return { status: 'error', data: null, error: err.message, classification };
  }
}

// Receive the specialist result - the real dispatch point, and the ONLY place a tool
// executor is ever invoked. Every call is gated by
// agent/core/toolPermissions.js's checkToolAccess() first - which tool is required
// comes from the caller (executionRequest.tool_id, decided by routing above);
// whether it's available, whether this specialist has permission, and whether
// approval is required are all decided there, not here. There is no path that skips
// this gate - the Chief has no unrestricted execution access. Never fabricates a
// result: a denied, unavailable, or approval-required tool all return an explicit,
// honest outcome instead of executing or guessing. runTokenTracker (see buildPlanStep
// and runOrchestratorContract below) is passed straight through to the executor -
// only ai_reasoning_completion's executor actually uses it, to enforce
// agent/core/tokenControls.js's run budget before ever calling Claude.
// ---------------------------------------------------------------------------------
// THE LIVE CALLER FOR THE PLATFORM GATE.
// ---------------------------------------------------------------------------------
//
// agent/core/toolPermissions.js's platform gate has existed since the capability/platform
// binding phase, but it is opt-in: it engages only when a caller supplies enabledPlatforms.
// Nothing in the execution path supplied it, so the gate was inert in production - a tool
// bound to a platform a business has not enabled was still dispatched. This resolver is
// that missing caller.
//
// CONFIGURATION IS THE ONLY AUTHORITY, exactly as configuration/business.example.yaml
// states. Nothing here reads a credential, and a credential never enables a platform.
//
// FAILS CLOSED. A business whose configuration cannot be read resolves to [] - no platform
// enabled - which denies every platform-bound tool. That is the honest reading of "we
// cannot tell whether this platform is permitted", and it is the same direction every other
// gate in this architecture fails.
//
// CACHED BY FILE MTIME, not for the process lifetime: the config is re-read whenever it
// actually changes, so an operator editing business.yaml takes effect on the next dispatch
// without a restart, and a test that writes a config mid-run is not served a stale answer.
const enabledPlatformsCache = new Map();

function resolveEnabledPlatformsForBusiness(businessId) {
  const key = typeof businessId === 'string' && businessId.trim() !== '' ? businessId.trim() : null;
  const configPath = key === null ? BUSINESS_CONFIG_PATH : path.join(__dirname, '..', '..', 'configuration', 'businesses', key, 'business.yaml');

  let mtimeMs = null;
  try {
    mtimeMs = fs.statSync(configPath).mtimeMs;
  } catch (err) {
    // No readable configuration file - deny every platform-bound tool.
    enabledPlatformsCache.delete(key);
    return [];
  }

  const cached = enabledPlatformsCache.get(key);
  if (cached && cached.mtimeMs === mtimeMs) return cached.platforms;

  let platforms;
  try {
    platforms = key === null ? readEnabledPlatforms(loadBusinessConfig(configPath)) : getEnabledPlatforms(key);
  } catch (err) {
    platforms = [];
  }
  enabledPlatformsCache.set(key, { mtimeMs, platforms });
  return platforms;
}

// The id for the next approval this run creates.
//
// `id_prefix` is optional and additive: a tracker that carries one (runOrchestratorContract
// sets it to that run's own id) produces '<runId>-apr-N', and a tracker without one
// produces 'apr-N' exactly as before. Sequence is per-run either way, so an id still reads
// as "the Nth approval of this run" rather than an opaque token.
//
// Sanitised to approvals/approvalStore.js's own filename-safe character set here rather
// than being silently mangled there, so the id in the challenge, the signature and the
// stored filename cannot diverge.
function approvalIdFor(runApprovalTracker) {
  const sequence = (runApprovalTracker && Array.isArray(runApprovalTracker.requests) ? runApprovalTracker.requests.length : 0) + 1;
  const rawPrefix = runApprovalTracker && typeof runApprovalTracker.id_prefix === 'string' ? runApprovalTracker.id_prefix.trim() : '';
  const prefix = rawPrefix.replace(/[^a-zA-Z0-9_-]/g, '');
  return prefix ? `${prefix}-apr-${sequence}` : `apr-${sequence}`;
}

// The execution request a pending approval must carry for `toolId` - the ONE place this is
// decided, so every producer of an approval (this contract's own approval branch, and
// autonomy/autonomousCycle.js when it queues a durable approval) attaches exactly the same
// thing and refuses in exactly the same cases.
//
// COMPLIANCE RIDES ON A CORRECTION'S APPROVAL, OR IT NEVER BECOMES EXECUTABLE.
// approvals/publishAuthorization.js refuses to authorize a mutation whose compliance cannot
// be RE-VERIFIED from the request's own content, so the input is computed here from the
// action's own parameters (buildCorrectionComplianceInput) and evaluated for real. It is
// attached BEFORE the approval record is built, so it is inside what the human's signature
// covers. A BLOCK creates no approval at all. A non-correction tool is returned unchanged.
//
// Returns { ok: true, executionRequest } or
// { ok: false, status, reason, audit_type, audit_status, compliance_status? }.
function prepareApprovalExecutionRequest(toolId, executionRequest) {
  if (!isCorrectionTool(toolId)) {
    return { ok: true, executionRequest };
  }

  const complianceInput = buildCorrectionComplianceInput(toolId, executionRequest);
  if (!complianceInput) {
    return {
      ok: false,
      status: 'denied',
      audit_type: 'error',
      audit_status: 'denied',
      reason:
        `The request for '${toolId}' does not state the parameters this correction writes, so its ` +
        'compliance could not be evaluated and no approval was created. Nothing was substituted.',
    };
  }

  let complianceResult;
  try {
    complianceResult = evaluateCompliance(complianceInput);
  } catch (err) {
    return {
      ok: false,
      status: 'error',
      audit_type: 'error',
      audit_status: 'error',
      reason: `Compliance could not be evaluated for '${toolId}', so no approval was created: ${err.message}`,
    };
  }

  // BLOCK IS ABSOLUTE - the same refusal approvals/complianceApprovalGate.js makes.
  if (complianceResult.status === 'BLOCK') {
    return {
      ok: false,
      status: 'denied',
      audit_type: 'approval',
      audit_status: 'blocked',
      compliance_status: 'BLOCK',
      reason:
        `Compliance returned BLOCK for '${toolId}', so no approval request was created and nothing ` +
        `can execute. Blocking findings: ${complianceResult.findings
          .filter((finding) => finding && finding.severity === 'block')
          .map((finding) => finding.rule_id)
          .join(', ') || '(none named)'}.`,
    };
  }

  // PASS and REVIEW both continue to the existing human-approval path, unchanged.
  return {
    ok: true,
    executionRequest: {
      ...executionRequest,
      compliance: summarizeComplianceForApproval(complianceResult),
      compliance_input: complianceInput,
    },
  };
}

async function executeSelectedCapability(
  executionRequest,
  runTokenTracker = { tokensUsedThisRun: 0 },
  runApprovalTracker = { requests: [] },
  runAuditTracker = null,
  runToolResultCache = null,
  runUsageTracker = null,
  runUsageLedger = null
) {
  const access = checkToolAccess({
    specialistId: executionRequest.specialist_id,
    toolId: executionRequest.tool_id,
    // THE PLATFORM GATE, ENGAGED FOR REAL. See resolveEnabledPlatformsForBusiness below.
    enabledPlatforms: resolveEnabledPlatformsForBusiness(executionRequest.business_id),
  });

  if (access.decision === 'unavailable') {
    const reason = access.tool_id ? access.reason : `Unknown tool: ${executionRequest.tool_id}`;
    appendAuditEvent(runAuditTracker, {
      type: 'error',
      toolId: access.tool_id || null,
      specialistId: executionRequest.specialist_id,
      status: access.tool_id ? 'not_available' : 'error',
      summary: reason,
    });
    return {
      status: access.tool_id ? 'not_available' : 'error',
      data: null,
      error: reason,
      classification: null,
    };
  }

  if (access.decision === 'denied') {
    appendAuditEvent(runAuditTracker, {
      type: 'error',
      toolId: access.tool_id || null,
      specialistId: executionRequest.specialist_id,
      status: 'denied',
      summary: access.reason,
    });
    return { status: 'denied', data: null, error: access.reason, classification: null };
  }

  // GATE 3 OF 3: THE TOOL-LEVEL PRECONDITION, independent of the router.
  //
  // Gates 1 and 2 stop a mutation tool being SELECTED. This one stops it being acted on
  // at all, however it got here - a caller that builds an executionRequest by hand, a
  // future routing path, or a routing bug that outlives this fix. A mutation tool with
  // no explicit instruction to mutate is refused before the approval request below is
  // created, which matters: without this, a read-only objective produces a real pending
  // approval to change live store data, and the only thing standing between that and a
  // mutation is a human noticing that the request should never have existed. Refusing
  // here means it never reaches them.
  //
  // Placed AFTER the availability and permission checks so those keep reporting their
  // own specific reasons first (existing behaviour unchanged), and BEFORE the approval
  // branch so nothing consequential is ever queued.
  //
  // DELIBERATELY NOT REPEATED IN resumeApprovedExecution: by then a human has signed an
  // Ed25519 approval over that exact execution fingerprint, which is a far stronger
  // authorization than anything re-derived from objective text - and re-deriving it
  // there would let a phrasing quirk void a cryptographically approved action. The
  // request can only have been created here in the first place, so this is the point
  // where it is actually preventable.
  // A correction whose values may only come from an EXISTING PROPOSAL (shopify_product_seo_update) is
  // held to that instead of to the objective's wording: the proposal it names is re-read from durable
  // approval state, and the request must be exactly it - this business, this product, the proposal's own
  // before/after values, and a proposal the owner has not rejected. Stronger than a verb in the text, and
  // it applies however the request was built. Without a matching proposal nothing is queued.
  if (requiresSourceProposal(access.tool_id)) {
    const source = verifyCorrectionSource(access.tool_id, executionRequest);
    if (!source.ok) {
      const reason = `Tool '${access.tool_id}' only applies an existing proposal, and this request does not match one (${source.reason_code}): ${source.reason} No approval was created.`;
      appendAuditEvent(runAuditTracker, {
        type: 'error',
        toolId: access.tool_id,
        specialistId: executionRequest.specialist_id,
        classification: access.classification,
        status: 'denied',
        summary: reason,
      });
      return { status: 'denied', data: null, error: reason, classification: access.classification, source_proposal: source.reason_code };
    }
  } else if (isCorrectionTool(access.tool_id) && !maySelectMutationTool(executionRequest.objective)) {
    const reason = mutationIntentRefusalReason(access.tool_id, executionRequest.objective);
    appendAuditEvent(runAuditTracker, {
      type: 'error',
      toolId: access.tool_id,
      specialistId: executionRequest.specialist_id,
      classification: access.classification,
      status: 'denied',
      summary: reason,
    });
    return {
      status: 'denied',
      data: null,
      error: reason,
      classification: access.classification,
      mutation_intent: classifyRequestIntent(executionRequest.objective),
    };
  }

  if (access.decision === 'approval_required') {
    // Real, trackable pending request - see approvals/approvalWorkflow.js. Never
    // executes here; execution only ever happens via resumeApprovedExecution() below,
    // once a real, accountable decideApprovalRequest(..., { decision: 'approved' })
    // call has happened (CLAUDE.md rule 7 - never silently perform a consequential
    // action). The id is deterministic per run (no randomness), matching every other
    // record in this project.
    // COMPLIANCE RIDES ON A CORRECTION'S APPROVAL, OR IT NEVER BECOMES EXECUTABLE.
    //
    // approvals/publishAuthorization.js refuses to authorize a mutation whose compliance
    // cannot be RE-VERIFIED from the request's own content. An approval created here with
    // no compliance input therefore verified cryptographically and then failed at
    // execution - which is exactly what happened to the first real controlled write.
    //
    // The verdict is COMPUTED from the action's own description (see
    // buildCorrectionComplianceInput), never supplied: there is no parameter here a caller
    // could use to claim one, and storing it is not what makes it trusted - the input is
    // stored so the engine can be run again independently at execution time and disagree.
    //
    // Attached BEFORE the approval record is built, so it is inside what the human's
    // signature covers: computeExecutionFingerprint spans the whole execution request, so
    // compliance input added after a challenge was issued would break that signature.
    const prepared = prepareApprovalExecutionRequest(access.tool_id, executionRequest);
    if (!prepared.ok) {
      appendAuditEvent(runAuditTracker, {
        type: prepared.audit_type,
        toolId: access.tool_id,
        specialistId: executionRequest.specialist_id,
        ...(prepared.status === 'error' ? {} : { classification: access.classification }),
        status: prepared.audit_status,
        summary: prepared.reason,
      });
      return {
        status: prepared.status,
        data: null,
        error: prepared.reason,
        classification: access.classification,
        ...(prepared.compliance_status ? { compliance_status: prepared.compliance_status } : {}),
      };
    }
    const approvalExecutionRequest = prepared.executionRequest;

    const approvalRequest = createApprovalRequest({
      // GLOBALLY UNIQUE ACROSS RUNS, because this id is now a durable filename.
      //
      // THE DEFECT THIS CLOSES. Every run starts its own tracker, so the first approval of
      // EVERY run was 'apr-1'. That was harmless while approvals lived only in memory, but
      // approvals/approvalStore.js keys a file by this id - so a later run silently
      // overwrote an earlier run's stored approval, and the earlier signature was left
      // bound to an execution request no longer in the store.
      //
      // The prefix is the run's OWN existing id (runOrchestratorContract's runId, already
      // unique and already used for the audit trail and usage ledger) - not a new
      // identifier, and not a random one, so an approval id still says which run produced
      // it. A caller that supplies no prefix keeps the old sequence exactly, which is what
      // keeps growthWorkflowOrchestrator and optimizationCycleOrchestrator unchanged.
      //
      // ONE ID, EVERYWHERE. This same value flows into the execution request, the
      // fingerprint the human signs, the challenge, the durable record, the approve
      // endpoint and the audit trail - there is no second identifier to keep in step.
      id: approvalIdFor(runApprovalTracker),
      classification: access.classification,
      specialistId: executionRequest.specialist_id,
      toolId: access.tool_id,
      executionRequest: approvalExecutionRequest,
      reason: access.reason,
    });
    runApprovalTracker.requests.push(approvalRequest);
    appendAuditEvent(runAuditTracker, {
      type: 'approval',
      toolId: access.tool_id,
      specialistId: executionRequest.specialist_id,
      classification: access.classification,
      status: 'pending',
      summary: `Approval request '${approvalRequest.id}' created: ${access.reason}`,
    });
    return {
      status: 'approval_required',
      data: null,
      error: access.reason,
      classification: access.classification,
      approval_request_id: approvalRequest.id,
    };
  }

  // BOUNDED RESEARCH CALLS (agent/core/executionBounds.js): checked only once
  // checkToolAccess has already said 'allowed' - no point validating input shape for
  // a tool that's denied/unavailable anyway. Refuses (never silently truncates) a
  // research_params array field over the configured max, so one call can never do
  // unbounded internal work (e.g. a keywords[] array of unbounded length).
  const boundsCheck = checkArrayFieldBounds(executionRequest.research_params);
  if (!boundsCheck.allowed) {
    appendAuditEvent(runAuditTracker, {
      type: 'error',
      toolId: access.tool_id,
      specialistId: executionRequest.specialist_id,
      classification: access.classification,
      status: 'error',
      summary: boundsCheck.reason,
    });
    return { status: 'error', data: null, error: boundsCheck.reason, classification: access.classification };
  }

  return runExecutor(access.tool_id, executionRequest, runTokenTracker, access.classification, runAuditTracker, runToolResultCache, runUsageTracker, runUsageLedger);
}

// Resumes a previously gated action after a real human decision has been recorded via
// approvals/approvalWorkflow.js's decideApprovalRequest(). This is the only path in the
// entire codebase that can execute a tool call that once required approval - and it
// only runs at all when decidedApprovalRequest.status === 'approved'; a 'pending' or
// 'rejected' record returns an honest non-executing outcome instead. Availability and
// specialist permission are re-checked at resume time (approval only ever satisfies the
// approval gate itself - a tool could have become unavailable, or specialist ownership
// could have changed, since the request was first created).
async function resumeApprovedExecution(
  decidedApprovalRequest,
  runTokenTracker = { tokensUsedThisRun: 0 },
  runAuditTracker = null,
  runToolResultCache = null,
  runUsageTracker = null,
  runUsageLedger = null,
  // OPTIONAL, AND DELIBERATELY CARRIES NOTHING FORGEABLE. The three Shopify corrections
  // need the server-held approval context their integration modules require, which the
  // ordinary executor contract does not pass. This parameter supplies only LOCATORS (which
  // durable store to read, plus the run's audit tracker) - never an approval record, never a
  // status, never an approver. integrations/approvedCorrectionDispatch.js loads the real
  // record from approvals/approvalStore.js and authorizes from THAT, so there is nothing
  // here a caller could manufacture. Omitted, every existing call site behaves exactly as
  // before.
  approvalContext = null
) {
  if (!decidedApprovalRequest || typeof decidedApprovalRequest !== 'object') {
    return {
      status: 'error',
      data: null,
      error: 'resumeApprovedExecution requires a decided approval request record.',
      classification: null,
    };
  }

  if (decidedApprovalRequest.status !== 'approved') {
    appendAuditEvent(runAuditTracker, {
      type: 'approval',
      toolId: decidedApprovalRequest.tool_id || null,
      specialistId: decidedApprovalRequest.specialist_id || null,
      classification: decidedApprovalRequest.classification || null,
      status: decidedApprovalRequest.status,
      summary: `Approval request '${decidedApprovalRequest.id}' is '${decidedApprovalRequest.status}' - not executed.`,
      detail: { decided_by: decidedApprovalRequest.decided_by || null },
    });
    return {
      status: decidedApprovalRequest.status === 'rejected' ? 'denied' : 'approval_required',
      data: null,
      error: `This action is '${decidedApprovalRequest.status}', not approved - it cannot be executed.`,
      classification: decidedApprovalRequest.classification,
    };
  }

  appendAuditEvent(runAuditTracker, {
    type: 'approval',
    toolId: decidedApprovalRequest.tool_id || null,
    specialistId: decidedApprovalRequest.specialist_id || null,
    classification: decidedApprovalRequest.classification || null,
    status: 'approved',
    summary: `Approval request '${decidedApprovalRequest.id}' approved - resuming execution.`,
    detail: { decided_by: decidedApprovalRequest.decided_by || null },
  });

  // Re-checked at resume time exactly like availability and specialist permission are:
  // an approval never outlives the business's own platform configuration.
  const resumeEnabledPlatforms = resolveEnabledPlatformsForBusiness(
    (decidedApprovalRequest.execution_request && decidedApprovalRequest.execution_request.business_id) || null
  );
  const access = checkToolAccess({
    specialistId: decidedApprovalRequest.specialist_id,
    toolId: decidedApprovalRequest.tool_id,
    enabledPlatforms: resumeEnabledPlatforms,
  });

  if (access.decision === 'unavailable' || access.decision === 'denied') {
    appendAuditEvent(runAuditTracker, {
      type: 'error',
      toolId: decidedApprovalRequest.tool_id || null,
      specialistId: decidedApprovalRequest.specialist_id || null,
      status: access.decision === 'unavailable' ? 'not_available' : 'denied',
      summary: access.reason,
    });
    return {
      status: access.decision === 'unavailable' ? 'not_available' : 'denied',
      data: null,
      error: access.reason,
      classification: null,
    };
  }

  // THE THREE APPROVED CORRECTIONS. They have no TOOL_EXECUTORS entry because their
  // integration functions need the approval context above; they are dispatched here, and
  // only here, and only on this path - which is reached only for a record whose status is
  // already 'approved', i.e. one that passed the Ed25519 gate.
  if (isCorrectionTool(access.tool_id)) {
    const outcome = await executeApprovedCorrection(decidedApprovalRequest, {
      storeDir: approvalContext && approvalContext.storeDir,
      auditTracker: runAuditTracker,
      // The same platform configuration just re-checked above: the independent verification
      // read is only made on a platform this business still enables.
      enabledPlatforms: resumeEnabledPlatforms,
      // undefined (never null) when no context was supplied, so the verification store keeps its
      // configured default location.
      verificationRootDir: (approvalContext && approvalContext.verificationRootDir) || undefined,
    });
    appendAuditEvent(runAuditTracker, {
      type: outcome.status === 'success' ? 'execution' : 'error',
      toolId: access.tool_id,
      specialistId: decidedApprovalRequest.specialist_id || null,
      classification: access.classification,
      status: outcome.status,
      summary: outcome.status === 'success'
        ? `Approved correction '${access.tool_id}' completed (${outcome.correction_status}).`
        : `Approved correction '${access.tool_id}' did not execute: ${outcome.error}`,
    });
    return {
      status: outcome.status,
      data: outcome.data,
      error: outcome.error,
      classification: access.classification,
      reason_code: outcome.reason_code || null,
      entity_verification: outcome.entity_verification || null,
    };
  }

  return runExecutor(
    access.tool_id,
    decidedApprovalRequest.execution_request,
    runTokenTracker,
    access.classification,
    runAuditTracker,
    runToolResultCache,
    runUsageTracker,
    runUsageLedger
  );
}

// Validate the result. Never treats an unverified/failed outcome as passed.
//
// outcome.status only reflects whether runExecutor's call itself threw - most tools
// (see agent/core/executionState.js's getToolResultStatus) never throw, they return
// their own honest { status, result, error } outcome instead, nested inside
// outcome.data. Without unwrapping that inner status, a tool-level 'failed'/'empty'
// result (e.g. required structured input was never supplied, or a live data pull
// found nothing) would be validated as 'passed' just because the call didn't throw -
// exactly the conflation that let a failed/empty specialist result get reported as a
// completed answer.
function validateResult(outcome) {
  if (!outcome || typeof outcome !== 'object' || !('status' in outcome)) {
    return 'failed';
  }
  if (outcome.status === 'error') {
    return 'failed';
  }
  if (outcome.status === 'success' && outcome.data) {
    const toolStatus = getToolResultStatus(outcome.data);
    if (toolStatus === 'failed') return 'failed';
    if (toolStatus === 'empty' || toolStatus === 'partial') return 'unverified';
    // toolStatus === 'success', or no { status, result, error } convention at all
    // (e.g. business_configuration_retrieval, ai_reasoning_completion) - a real
    // success either way.
    return 'passed';
  }
  return 'unverified';
}

// ---------------------------------------------------------------------------------
// Structured routing
// ---------------------------------------------------------------------------------
//
// SPECIALIST_TO_CATEGORIES and SHARED_INFRASTRUCTURE_CATEGORIES are imported from
// agent/core/toolPermissions.js above - that module is now the single owner of "which
// specialist may use which tool category" (CLAUDE.md section 3's Permissions
// component), reused here for routing rather than duplicated.

// One routing target per approved specialist (all 7 - see
// agent/core/specialistCapabilityRegistry.js, this orchestrator's connection to the
// specialist registry), plus one per shared-infrastructure category (keyword text
// derived from the tools already registered under that category). Built once at
// module load from the existing registries - not new data. Specialist id/title/
// description come from the capability registry, which reuses
// agent/core/specialistRegistry.js verbatim (see that registry's own tests) - so this
// is byte-identical to routing directly against specialistRegistry.js, not a new
// source of truth.
// Small, additive vocabulary layered onto specific specialists' ROUTING text only
// (never their real registry title/description, which stays exactly as
// agent/core/specialistRegistry.js defines it - this never touches that file, so it
// cannot duplicate or diverge from it per CLAUDE.md rule 4). This exists because a
// generic word a business owner naturally uses (e.g. "analyze my business") can
// otherwise only match a shared-infrastructure tool purely by naming coincidence -
// e.g. tools/businessConfigurationRetrieval.js's own title is literally "Business
// configuration retrieval", so the standalone word "business" scores a point there
// even though that tool only fetches the shop's name/domain/email, not a real
// analysis. "Analyze my ecommerce business" therefore scored 0 for every specialist
// and 1 for the "configuration" shared-infrastructure target, so it silently won -
// not ambiguous, not unmatched, just wrong. Every specialist's own description
// already covers this: analytics_optimization's is literally "Store performance,
// growth metrics, and optimization recommendations" - i.e. analyzing the business -
// so this only adds words, never removes any, meaning every routing decision that
// worked before this change keeps working unchanged (see
// verification/testing/orchestratorExecutionContract.test.js's pinned routeClause/
// planRouting cases, plus the new "analyze my business" regression cases added
// alongside this change).
// product: 'shopify' and 'products' (plural) - the same bare-word-coincidence problem
// analytics_optimization already had above, but for Product: tools/toolRegistry.js's
// business_configuration_retrieval entry literally contains "Shopify" in its own
// description (it fetches the connected Shopify store's shop identity), and
// tokenize() does exact matching with no stemming, so the plural "products" never
// matched agent/core/specialistRegistry.js's Product description ("product" singular,
// 3x). A clause like "Analyze my Shopify products" therefore scored 0 for Product and
// 1 for the "configuration" shared-infrastructure target on "shopify" alone, so
// configuration silently won a clause about products, not configuration - not
// ambiguous, not unmatched, just wrong (see
// verification/testing/orchestratorExecutionContract.test.js's regression cases added
// alongside this change).
// PHASE 1 REGRESSION (real-world testing): tokenize() has no stemming, so a plural a
// business owner naturally types never matched these specialists' singular
// title/description vocabulary, silently producing "unmatched" for an ordinary
// request instead of routing it - "What keywords should we target for our SVG bundle
// listings?" scored 0 everywhere (seo's own text only has "keyword" singular, from
// "Search visibility analysis and keyword research"; listing's only has "listing"
// singular, from "Product listing content and optimization"), and "How many orders
// have we had recently?" scored 0 everywhere too (analytics_optimization's text never
// mentioned orders at all, despite analyticsDataTool.js/orderModel.js existing
// specifically for order data). Same bug class, same fix, as the "shopify"/"products"
// and "business" entries above - additive vocabulary only, never touching
// agent/core/specialistRegistry.js's real title/description (see
// verification/testing/orchestratorExecutionContract.test.js's regression cases added
// alongside this change).
// PHASE 1 REGRESSION (real-world testing): "Write new titles for our existing product
// listings." misrouted to Product (score 6) over Listing (score 3). "product" is a
// generic e-commerce noun that appears as an incidental modifier in objectives
// belonging to many other specialists ("product listings", "product pricing",
// "product marketing"), yet it was in GOAL_ROUTING_WORDS (weight 2) - combined with its
// structural 3x repetition in Product's own id/title/description, that let it
// single-handedly outscore Listing's real action vocabulary. Reclassified into
// GENERIC_ROUTING_WORDS below (weight 0.5, same bucket "business" already occupies for
// the identical reason - see that set's own comment) rather than removed from routing
// entirely: it still helps Product win a genuine tie, it just can no longer overpower
// another specialist's real intent signal on its own. Product's own
// id/title/description/ROUTING_SYNONYMS.product are completely unchanged - only its
// weight classification moved.
// READ-ONLY ROUTING COVERAGE (real production validation): the catalogue-diagnostic
// vocabulary a store owner actually types was in NO specialist's routing text at all.
// agent/core/specialistRegistry.js's Product description is "Product catalog analysis
// and opportunity research." - it never says "vendor" or "inventory", even though
// Product owns product_data_retrieval, whose records carry exactly those two fields.
// Measured before this entry, against the real store:
//
//   "Report inventory and vendor issues"        -> scored 0 EVERYWHERE -> clarification
//   "Analyze my Shopify products for vendor
//    and inventory"                             -> "inventory" split off as its own
//                                                  clause, scored 0 -> clarification
//   "Check inventory problems."                 -> shared_infrastructure:compliance,
//                                                  on the bare word "problems"
//
// Same bug class and same additive fix as the "shopify"/"products", "business",
// "orders" and offer-vocabulary entries above: routing vocabulary only, and Product's
// real id/title/description are untouched.
//
// WHY THESE THREE AND NOT MORE. "vendor"/"vendors" is a Shopify product FIELD - only a
// product has one - so it cannot belong to another specialist. "inventory" is the
// weaker of the two (Analytics legitimately reports on stock as well), so it is added
// at the default weight of 1, where Analytics' own goal vocabulary - "sales",
// "revenue", "performance", "orders" - still outscores it at weight 2 on a genuine
// analytics request. Verified against the full corpus: no existing route moved.
//
// THIS CHANGES WHICH SPECIALIST IS CHOSEN, NEVER WHETHER A MUTATION IS ELIGIBLE. Tool
// selection inside the chosen specialist still runs through
// filterToolCandidatesByIntent (agent/core/mutationIntent.js), so a read-only request
// routed here still has every correction tool removed from its candidate list before
// scoring. Naming a vendor or an inventory is how you say WHAT to look at; it remains
// incapable of saying "change it".
const ROUTING_SYNONYMS = {
  // 'analyse': the British spelling the store owner actually types ("Analyse my sales"),
  // mirroring 'analyze' exactly - same target, same GENERIC_ROUTING_WORDS weight.
  analytics_optimization: ['analyze', 'analyse', 'analysis', 'business', 'ecommerce', 'commerce', 'orders'],
  // 'opportunities': Product's description already says "opportunity research", and
  // "biggest sales opportunity" is pinned to Product - but the plural scored 0 everywhere,
  // so "sales opportunities" from the Chief dashboard dead-ended the whole request. Same
  // plural gap, same additive fix, as 'products'/'vendors'.
  product: ['shopify', 'products', 'vendor', 'vendors', 'inventory', 'opportunities'],
  seo: ['keywords'],
  listing: ['listings', 'titles'],
  // Same bug class and same additive fix as the "shopify"/"products", "business" and
  // "orders" entries above, found when wiring agent/core/offerRecommendationEngine.js:
  // agent/core/specialistRegistry.js's Marketing description ("Campaign ideas, copy, and
  // marketing strategy.") contains no offer vocabulary at all, so an objective about a
  // bundle, an upsell or a supportable discount depth scored 0 for Marketing and was
  // routed to Product instead - despite tools/offerRecommendationTool.js and the
  // existing `offers`/`promotions` capabilities existing for exactly that request.
  // Additive routing vocabulary only: Marketing's real id/title/description are
  // unchanged. Deliberately excludes "margin" and "price"/"pricing", which belong to
  // Product/Analytics evidence just as often as to an offer - and, verified against
  // this file's own tests, "bundle"/"bundles": that is a generic e-commerce noun of
  // exactly the "product" shape described above, appearing as an incidental modifier in
  // objectives that belong elsewhere ("our SVG bundle" -> SEO, "our bundle listings" ->
  // Listing), and adding it flipped both of those pinned routes to Marketing.
  marketing: ['offer', 'offers', 'discount', 'discounts', 'upsell'],
};

// Generic words a user naturally types that, on their own, do not indicate which
// specialist or shared-infrastructure tool is actually meant (e.g. "business" also
// appears in tools/businessConfigurationRetrieval.js's own title, "analyze" says
// nothing about which domain to analyze; "product" is the same shape of problem - it
// is a generic e-commerce noun that shows up as an incidental modifier in objectives
// belonging to Listing, Marketing, SEO, etc., not just Product - see this block's own
// PHASE 1 REGRESSION comment above). Scored at a reduced weight below instead of being
// ignored outright, so they can still help resolve a genuine tie without being able to
// single-handedly decide a route the way a real intent signal can.
const GENERIC_ROUTING_WORDS = new Set(['business', 'analyze', 'analyse', 'information', 'help', 'check', 'data', 'product']);
const GENERIC_ROUTING_WORD_WEIGHT = 0.5;

// Concrete goal/action vocabulary that reliably signals which specialist a request
// belongs to. Weighted above the default so a real intent signal (e.g. "sales", "seo")
// outweighs an incidental word overlap elsewhere (e.g. a shared-infrastructure tool's
// own file-path/description text happening to contain "shopify" or "retrieval").
const GOAL_ROUTING_WORDS = new Set([
  'sales', 'revenue', 'growth', 'performance', 'conversion', 'seo',
  'marketing', 'advertising', 'social', 'media', 'research',
]);
const GOAL_ROUTING_WORD_WEIGHT = 2;

function routingWordWeight(word) {
  if (GENERIC_ROUTING_WORDS.has(word)) return GENERIC_ROUTING_WORD_WEIGHT;
  if (GOAL_ROUTING_WORDS.has(word)) return GOAL_ROUTING_WORD_WEIGHT;
  return 1;
}

function buildRoutingTargets() {
  const specialistTargets = getSpecialistCapabilityRegistry().map((specialist) => ({
    type: 'specialist',
    id: specialist.id,
    title: specialist.title,
    text: [
      specialist.id,
      specialist.title,
      specialist.description,
      ...(ROUTING_SYNONYMS[specialist.id] || []),
    ].join(' '),
  }));

  const sharedInfrastructureTargets = SHARED_INFRASTRUCTURE_CATEGORIES.map((category) => {
    const toolsInCategory = getToolsByCategory(category);
    const text = [
      category,
      ...toolsInCategory.flatMap((tool) => [tool.id, tool.title, tool.description]),
    ].join(' ');
    return { type: 'shared_infrastructure', id: category, title: category, text };
  });

  return [...specialistTargets, ...sharedInfrastructureTargets];
}

const ROUTING_TARGETS = buildRoutingTargets();

// Scores every routing target against a piece of text using the same word-overlap
// approach as identifyRequiredCapability, generalized to specialists + shared
// infrastructure. Returns only targets that scored above zero, highest first.
function scoreRoutingTargets(text) {
  const words = new Set(tokenize(text));
  if (words.size === 0) return [];

  return ROUTING_TARGETS.map((target) => {
    const targetWords = tokenize(target.text);
    let score = 0;
    for (const word of targetWords) {
      if (words.has(word)) score += routingWordWeight(word);
    }
    return { target, score };
  })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
}

// Splits an objective into independent clauses on common conjunctions/list
// separators, so a multi-part request ("research X and optimize Y") can be routed to
// more than one target instead of forcing a single pick.
// REGRESSION (real-world testing): a bare `,` also matches the thousands separator
// inside a plain number/product name ("1,000 Funny T-Shirt SVG Bundle", "$2,500
// budget"), tearing it in half ("Look up the '1" / "000 Funny T-Shirt SVG Bundle'...")
// and leaving the first fragment unmatchable to any real capability. The comma
// alternative below only fires when it is NOT immediately flanked by a digit on both
// sides, which a genuine clause-separating comma (always followed by a space or the
// start of a new word, never by a digit) still satisfies unchanged - this narrows
// comma-splitting only for the specific digit-comma-digit case, never anything else.
const CLAUSE_SPLIT_REGEX = /\s*(?:(?<!\d),(?!\d)|;|\band\b|\balso\b|\bas well as\b|\bthen\b|\bplus\b)\s*/i;

// PHASE 2 REGRESSION (real-world testing): CLAUSE_SPLIT_REGEX has no grammar
// awareness, so it splits "research my top competitors for my digital PNG and SVG
// bundle products" (ONE topic that happens to list two file-format item types) exactly
// the same way it splits "market competitor research and social media advertising"
// (genuinely TWO separate tasks) - the comma variant ("...digital PNG ,SVG bundle
// products") has the identical problem via the `,` branch of the same regex. A real
// client describing their own digital-product catalog has no way to know which
// punctuation is "safe" - and per this project's own standard, they should never have
// to. A pure confidence-score threshold on the split-off fragment was tried and
// rejected: it was verified empirically (see this file's own test suite run history)
// to also fold back genuinely-intentional second clauses that happen to score just as
// low on generic wording alone (e.g. "identify the biggest sales opportunity" scores 1,
// indistinguishable by magnitude from a spurious "SVG bundle products" fragment, which
// also scores 1). Fixed instead at the tokenization boundary, before CLAUSE_SPLIT_REGEX
// ever runs: protectFileFormatLists() (below) recognizes a run of two or more known
// file-format tokens (the exact kind of list a digital-product seller's objective
// naturally contains - png, svg, jpg, pdf, etc.) joined only by "and"/comma, and fuses
// the run into a single non-splitting token (join words with "-" and swap the
// conjunction for "&") before splitting happens. This is deliberately narrow - it only
// ever changes text that is ENTIRELY recognized file-format tokens end-to-end
// (see FILE_FORMAT_TOKENS/protectFileFormatLists below), so it cannot touch a
// legitimate two-task objective ("business" and "identify" are not file-format tokens,
// so "analyze my business and identify the biggest sales opportunity" is left
// completely unmodified and still splits into two clauses exactly as before).
const FILE_FORMAT_TOKENS = new Set([
  'png', 'svg', 'jpg', 'jpeg', 'pdf', 'psd', 'ai', 'eps', 'gif', 'webp',
  'mp3', 'mp4', 'mov', 'docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls', 'csv',
  'zip', 'tiff', 'tif', 'bmp', 'ico', 'ttf', 'otf', 'woff', 'html', 'css',
  'json', 'txt', 'stl', 'dxf', 'procreate', 'canva',
]);

// Matches one contiguous run of 2+ words joined only by "and"/comma, including an
// Oxford-comma tail (e.g. "PNG and SVG", "PNG, SVG, JPG", "PNG, SVG, and JPG") -
// deliberately loose (word-level, not format-aware) at the regex stage; every word in
// the matched run is then checked against FILE_FORMAT_TOKENS below, so a run
// containing any non-format word is left untouched. The three alternatives inside the
// repeated group are ordered and mutually exclusive on purpose: ", and word" (Oxford
// comma) is tried before plain ", word" so a trailing "and" is consumed as part of the
// delimiter, never as a list item itself; the negative lookahead on the plain-comma
// branch (?!and\b) exists for the same reason - without it ", and" would match the
// plain-comma branch first with "and" mistaken for the next item's word.
const AND_COMMA_LIST_REGEX = /\b[A-Za-z]+(?:\s*,\s*and\s+[A-Za-z]+|\s*,\s*(?!and\b)[A-Za-z]+|\s+and\s+[A-Za-z]+)+\b/gi;

// Rewrites the objective text (never the underlying data/business meaning) so that a
// pure list of file-format names joined by "and"/comma survives CLAUSE_SPLIT_REGEX as
// one clause instead of being torn into separate fragments. Returns the original
// string unchanged whenever no run is found, or whenever a found run contains even one
// word that isn't a recognized file-format token - so this can only ever make routing
// MORE permissive for genuine format lists, never change behavior for anything else.
function protectFileFormatLists(objective) {
  return objective.replace(AND_COMMA_LIST_REGEX, (run) => {
    const words = run.split(/\s*(?:,|\band\b)\s*/i).filter((word) => word.length > 0);
    if (words.length < 2) return run;
    const allRecognized = words.every((word) => FILE_FORMAT_TOKENS.has(word.toLowerCase()));
    if (!allRecognized) return run;
    return words.join('-');
  });
}

// SENTENCES ARE CLAUSE BOUNDARIES. Splitting only on commas/"and" left several sentences in
// one clause, so an extra sentence rode along with whichever task its neighbour routed to:
// "Analyse my store's SEO findings. Show the Amazon pricing issue." planned SEO and silently
// dropped the Amazon request, and "... SEO findings. Show the advertising issue." tied the
// whole clause between two specialists. A sentence end is a stronger boundary than a comma,
// so it is applied first; the instruction parser then sees every sentence. The terminator is
// kept on the clause, which is how a list item knows its sentence has ended.
function splitIntoClauseUnits(objective) {
  return protectFileFormatLists(objective)
    .split(/(?<=[.!?])\s+/)
    .flatMap((sentence, sentenceIndex) =>
      sentence
        .split(CLAUSE_SPLIT_REGEX)
        .map((clause) => clause.trim())
        .filter((clause) => clause.length > 0)
        // The sentence index lets a list item continue only the clause before it in the SAME
        // sentence (see objectiveInterpretation.interpretClause).
        .map((text) => ({ text, sentence: sentenceIndex }))
    );
}

function splitIntoClauses(objective) {
  return splitIntoClauseUnits(objective).map((unit) => unit.text);
}

// Routes a single clause: unmatched (nothing scored), matched (exactly one target has
// the top score), or ambiguous (two or more targets tie for the top score - the
// clause genuinely could mean more than one thing, so it is never silently resolved).
function routeClause(clauseText) {
  const scored = scoreRoutingTargets(clauseText);
  if (scored.length === 0) {
    return { status: 'unmatched', segment: clauseText };
  }

  const topScore = scored[0].score;
  let tied = scored.filter((entry) => entry.score === topScore);

  // Shared infrastructure (e.g. configuration retrieval) is a context provider, not a
  // final-task specialist (CLAUDE.md section 3) - if a real specialist ties with one
  // for the top score, the specialist wins the tie instead of forcing an unnecessary
  // clarification prompt or letting the infrastructure tool win on incidental wording.
  const tiedSpecialists = tied.filter((entry) => entry.target.type === 'specialist');
  if (tiedSpecialists.length > 0) {
    tied = tiedSpecialists;
  }

  if (tied.length > 1) {
    return {
      status: 'ambiguous',
      segment: clauseText,
      candidates: tied.map((entry) => ({
        type: entry.target.type,
        id: entry.target.id,
        title: entry.target.title,
      })),
    };
  }

  return { status: 'matched', segment: clauseText, target: tied[0].target };
}

// A closed set of referring pronouns/determiners that (in this project's domain -
// short task instructions, never narrative prose) essentially only ever open a
// grammatically-dependent continuation of the PRECEDING clause ("...and THEIR current
// status", "...and ITS availability", "...and THAT information"), never a genuinely
// new, independent top-level instruction. Deliberately excludes first/second-person
// words (we/our/us/you/your/my) - those routinely open a real second instruction on
// their own ("Also update our product descriptions"), so treating them as always-
// dependent would risk silently folding a genuinely separate request into the
// previous one. This is the eligibility gate for attemptClauseRecovery() below: an
// unmatched clause is only ever a merge candidate when it starts with one of these
// words, which is what keeps a genuinely-unrecognized second instruction (e.g. this
// file's own "...and do the flibbertigibbet dance" regression test) correctly
// surfaced for clarification instead of being silently swallowed into its neighbor.
const DEPENDENT_FRAGMENT_STARTERS = new Set([
  'their', 'theirs', 'them', 'themselves', 'it', 'its', 'itself',
  'this', 'that', 'these', 'those', 'he', 'him', 'his', 'himself',
  'she', 'her', 'hers', 'herself',
]);

// True when `text` opens with one of DEPENDENT_FRAGMENT_STARTERS - i.e. it reads as a
// continuation of whatever came before it, not a standalone instruction. Only the
// first word matters; matched case-insensitively against tokenize()'s own word
// boundaries so leading punctuation ("Their current status.") never defeats it.
function looksLikeDependentFragment(text) {
  const words = tokenize(text);
  return words.length > 0 && DEPENDENT_FRAGMENT_STARTERS.has(words[0]);
}

// REAL-WORLD REGRESSION (reported live by the store owner): CLAUSE_SPLIT_REGEX's own
// header already documents that it cannot tell a genuine second instruction apart from
// one instruction that merely contains "and"/comma internally - protectFileFormatLists()
// above narrows that for the one case it can recognize safely (a bare list of file-
// format names). It cannot help a plain-English trailing phrase: "Also discover our
// real active products and their current status." splits (correctly, per the regex's
// own rules) into "discover our real active products" (matches Product's
// product_discovery) and "their current status." - a fragment with zero words in
// common with any capability, so routeClause() reports it 'unmatched' and the ENTIRE
// request stops for clarification, even though a person reading the original sentence
// never intended two separate instructions. A store owner - or, eventually, this
// project's own end customers per CLAUDE.md section 1's SaaS goal - cannot be expected
// to know which of their own words are "safe" split points; per this project's
// standard (see CLAUSE_SPLIT_REGEX's header) they should never have to.
//
// attemptClauseRecovery() is the fix, applied AFTER every clause has already been
// routed independently (so it never changes behavior for an objective that already
// worked - it only ever fires on a clause that would otherwise dead-end the whole
// request). For each 'unmatched' clause, it re-joins the clause's own original text
// with an immediately adjacent clause's own original text (previous first - a trailing
// dangling phrase, the common case demonstrated above; then next, the symmetric leading
// case) and re-routes the COMBINED text as one clause. If that combined text resolves
// to anything other than 'unmatched' (a clean match, or even a genuine 'ambiguous' - a
// real two-target conflict named for the person to resolve is still strictly more
// useful than an opaque "your 3-word fragment matches nothing"), the merge is kept: the
// neighbor's entry is updated to the combined text/result, and the original clause is
// marked 'absorbed' so the final pass below skips it instead of double-reporting or
// double-counting it as its own step. Deliberately conservative: a clause is only ever
// merged into a neighbor that is itself cleanly 'matched' at the time - never into
// another 'unmatched' or 'ambiguous' neighbor, and never overriding a clause that
// already matched something on its own. Runs its scan repeatedly (bounded by the
// number of clauses, so it always terminates) so a run of 3+ fragments from the same
// over-split sentence resolves via chained merges, not just an immediately-adjacent
// pair - verified by this file's own test suite (see the "chain" regression test).
function attemptClauseRecovery(routedClauses) {
  let changedThisPass = true;
  let passesRemaining = routedClauses.length;

  while (changedThisPass && passesRemaining > 0) {
    changedThisPass = false;
    passesRemaining -= 1;

    for (let i = 0; i < routedClauses.length; i += 1) {
      if (routedClauses[i].result.status !== 'unmatched') continue;
      if (!looksLikeDependentFragment(routedClauses[i].text)) continue;

      const mergeWith = (neighborIndex, buildMergedText) => {
        const neighbor = routedClauses[neighborIndex];
        if (!neighbor || neighbor.result.status !== 'matched') return false;

        const mergedText = buildMergedText(neighbor.text, routedClauses[i].text);
        const mergedResult = routeClause(mergedText);
        if (mergedResult.status === 'unmatched') return false;

        routedClauses[neighborIndex] = { text: mergedText, sentence: neighbor.sentence, result: mergedResult };
        routedClauses[i] = { text: mergedText, sentence: routedClauses[i].sentence, result: { status: 'absorbed' } };
        return true;
      };

      // Previous clause first (the dangling-trailing-phrase case demonstrated above),
      // then next (the symmetric leading-phrase case), never both for the same clause.
      if (mergeWith(i - 1, (prevText, ownText) => `${prevText} ${ownText}`)) {
        changedThisPass = true;
        continue;
      }
      if (mergeWith(i + 1, (nextText, ownText) => `${ownText} ${nextText}`)) {
        changedThisPass = true;
      }
    }
  }

  return routedClauses;
}

// OBJECTIVE-LEVEL INTENT - one objective, one business task.
//
// An owner writes ONE objective in plain sentences. Routing every comma/"and" fragment by word
// overlap asked each fragment to name a capability on its own, so ordinary answer language
// ("Identify the most important actions needed to increase sales", "explain each issue", "show
// the actual issue") dead-ended the whole request, and a consequential request whose NOUN routed
// ("Delete my worst products") was silently planned as a read. Word lists were patched three
// times; each new phrasing found the next gap. The fix is to decide what each clause ASKS FOR
// before routing, then resolve the objective as a whole:
//
//   1. Each clause is classified by its speech act (agent/core/objectiveInterpretation.js):
//      safety / inform / goal / scope / produce / change / unsupported action / unsupported
//      platform - from sentence structure and the three tool operations, never subject words.
//   2. TASK clauses select specialists: a produce or change request that routed (unchanged
//      behaviour, still gated downstream), and a read-type clause whose words DISTINCTIVELY
//      name a specialist - generic routing words, instruction verbs and parts of an answer do
//      not count, so "compare the results" or "rank the problems" cannot add a step. A read-type
//      clause that names no specialist but names a declared CAPABILITY ("increase sales" ->
//      Analytics' sales capability) selects that capability's specialist.
//   3. Every other read-type clause is FRAMING or SCOPE of the task - unless it introduces a
//      noun phrase unrelated to both the system and the objective, which still asks.
//   4. An unsupported action or platform stops the plan with a reason that names it, and the
//      AI re-segmentation fallback is not attempted (it could only re-route the same nouns).
// An objective with no task clause keeps the original per-clause outcome, so a message made
// only of framing or constraints ("Do not make any changes.") still asks what to work on.

// Every word this system itself declares: routing text, capability ids/titles/descriptions,
// tool titles/descriptions and the goal vocabulary. Derived, never hand-listed - a new
// capability widens what an objective may talk about automatically.
const SYSTEM_VOCABULARY = (() => {
  const words = new Set();
  const add = (text) => {
    for (const word of String(text || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length > 1) {
        words.add(word);
        words.add(singularForm(word));
      }
    }
  };
  for (const target of ROUTING_TARGETS) add(target.text);
  for (const specialist of getSpecialistCapabilityRegistry()) {
    for (const task of specialist.supported_tasks) add(`${task.id.replace(/_/g, ' ')} ${task.title} ${task.description}`);
  }
  for (const tool of TOOL_REGISTRY) add(`${tool.id.replace(/_/g, ' ')} ${tool.title} ${tool.description}`);
  for (const word of GOAL_ROUTING_WORDS) add(word);
  for (const word of GENERIC_ROUTING_WORDS) add(word);
  return words;
})();

function isSystemWord(word) {
  const lower = String(word || '').toLowerCase();
  return SYSTEM_VOCABULARY.has(lower) || SYSTEM_VOCABULARY.has(singularForm(lower));
}

// Routing words shared with a target that actually say WHICH target: not generic, not an
// instruction verb, not a part of an answer, and not the name of the connected platform (which
// says where to look - "my Shopify sales" is about sales, not about the Product catalogue).
function distinctiveRoutingWords(clauseText, target) {
  const clauseWords = new Set(tokenize(clauseText));
  // Shared infrastructure is a context provider (CLAUDE.md section 3): it is asked for by NAME
  // ("my business configuration", "a compliance check"), never inferred from description words
  // that overlap ordinary language ("where my revenue is coming from" -> memory on "from").
  if (target.type === 'shared_infrastructure' && !target.id.split('_').every((word) => clauseWords.has(word))) {
    return [];
  }
  // A target's own name and declared remit ("research" for Research, "opportunity research" for
  // Product - specialistCapabilityRegistry.js) always identify it, even where the same word is
  // also an instruction verb or a part of an answer.
  const remit = target.type === 'specialist' ? (getSpecialistCapabilityById(target.id) || {}).description : '';
  // ...and so does the target's declared routing vocabulary (ROUTING_SYNONYMS: "orders" for
  // Analytics), even where a word doubles as a part of an answer ("in order of priority").
  const synonyms = target.type === 'specialist' ? ROUTING_SYNONYMS[target.id] || [] : [];
  const nameWords = new Set(tokenize(`${target.id.replace(/_/g, ' ')} ${target.title} ${remit || ''} ${synonyms.join(' ')}`));
  return [...new Set(tokenize(target.text))].filter(
    (word) =>
      clauseWords.has(word) &&
      !GENERIC_ROUTING_WORDS.has(word) &&
      !isConnectedPlatformName(word) &&
      (nameWords.has(word) || !isInstructionWord(word))
  );
}

// routeClause restricted to distinctive evidence. A specialist with distinctive evidence is
// preferred over shared infrastructure (a context provider, CLAUDE.md section 3).
function distinctiveRoute(clauseText) {
  const scored = scoreRoutingTargets(clauseText).filter((entry) => distinctiveRoutingWords(clauseText, entry.target).length > 0);
  const specialists = scored.filter((entry) => entry.target.type === 'specialist');
  const pool = specialists.length > 0 ? specialists : scored;
  if (pool.length === 0) return null;
  const tied = pool.filter((entry) => entry.score === pool[0].score);
  return tied.length === 1
    ? { status: 'matched', target: tied[0].target }
    : { status: 'ambiguous', candidates: tied.map((entry) => entry.target) };
}

// A read-type clause that names no specialist may still name a declared capability ("increase
// sales" -> analytics_optimization's `sales`). The specialist declaring the most capabilities
// named by the clause wins; a tie selects nothing. When the objective already has a task on
// the store, only capabilities that read a connected store platform are eligible, so answer
// language ("summarise the trends") cannot pull in unrelated market research.
function capabilityFallbackTarget(clauseText, { storeScopedOnly }) {
  const words = new Set(
    tokenize(clauseText).map(singularForm).filter((word) => !GENERIC_ROUTING_WORDS.has(word) && !isInstructionWord(word))
  );
  if (words.size === 0) return null;
  const counts = [];
  for (const specialist of getSpecialistCapabilityRegistry()) {
    const named = specialist.supported_tasks.filter((task) => {
      if (storeScopedOnly && !(Array.isArray(task.platforms) && task.platforms.length > 0)) return false;
      const names = new Set(tokenize(`${task.id.replace(/_/g, ' ')} ${task.title}`).map(singularForm));
      return [...words].some((word) => names.has(word));
    });
    if (named.length > 0) counts.push({ id: specialist.id, count: named.length });
  }
  if (counts.length === 0) return null;
  counts.sort((a, b) => b.count - a.count);
  if (counts.length > 1 && counts[1].count === counts[0].count) return null;
  return ROUTING_TARGETS.find((target) => target.type === 'specialist' && target.id === counts[0].id) || null;
}

// A route that rests only on the connected platform's name ("my Shopify sales" -> Product via
// "shopify") says where to look, not what to look at - so a declared capability may refine it.
function matchRestsOnPlatformName(clauseText, target) {
  const clauseWords = new Set(tokenize(clauseText));
  const overlap = tokenize(target.text).filter((word) => clauseWords.has(word) && !GENERIC_ROUTING_WORDS.has(word));
  return overlap.length > 0 && overlap.every((word) => isConnectedPlatformName(word));
}

function targetKey(target) {
  return `${target.type}:${target.id}`;
}

function candidateSummary(target) {
  return { type: target.type, id: target.id, title: target.title };
}

// A CAPABILITY THAT NAMES THE PLATFORM THE CLAUSE NAMES.
//
// distinctiveRoutingWords above drops a connected platform's name on purpose: "my Shopify sales"
// is about sales, and the platform only says WHERE to look. That is right for a platform named
// beside an ordinary subject - and wrong for the one case where the platform name is the subject:
// a capability that carries the platform in its OWN id/title (etsy_shop_inspection - "the Etsy
// shop's own record") is asked for by naming that platform and that object, and nothing else in
// the clause has to carry the route. Without this, "inspect my connected Etsy store" had no Etsy
// evidence left at all and was routed to Analytics on the single incidental word "store" (from
// "Store performance ..." in that specialist's description), which then read SHOPIFY.
//
// Narrow by construction, in three ways:
//   1. Exactly ONE connected platform may be named. Two ("my Etsy listings and my Shopify
//      products") is a request about both, and this rule says nothing about it.
//   2. Only tasks whose platforms include it AND whose own id/title names it are eligible - so a
//      task that merely reaches the platform (catalogue_expansion_opportunities, ['etsy',
//      'shopify']) is not pulled in by the platform name, and a clause naming a platform no
//      capability is named after resolves to nothing and keeps its existing routing untouched.
//   3. It DECLINES to a specialist the clause names by that specialist's own id/title/
//      ROUTING_SYNONYMS vocabulary, which is a stronger signal than the platform. "Analyse my
//      Etsy invitation listings" is Listing's, not the Etsy shop record's; only a competitor
//      resting on description-level wording (Analytics' "store") is overridden.
// Ties across two specialists select nothing, exactly like capabilityFallbackTarget above.
// The name words of one capability task - its id and title only, never its description.
function capabilityNameWords(task) {
  return new Set(tokenize(`${task.id.replace(/_/g, ' ')} ${task.title}`).map(singularForm));
}

// How many of a task's own name words the clause uses. A word that is also an instruction word
// counts ONLY when the task is named after it - the same escape distinctiveRoutingWords already
// makes for a target's own name, and the reason "analyze my current active digital listings" can
// name etsy_listing_inspection at all: "listing" is a read verb by lemma ("list") and is also
// that capability's own noun.
function capabilityNameMatchCount(clauseText, task) {
  const names = capabilityNameWords(task);
  const words = new Set(
    tokenize(clauseText)
      .map(singularForm)
      .filter((word) => !GENERIC_ROUTING_WORDS.has(word) && (names.has(word) || !isInstructionWord(word)))
  );
  let matched = 0;
  for (const word of words) if (names.has(word)) matched += 1;
  return matched;
}

// The specialist whose platform-bound capabilities the clause names, and the best-matching one
// of them. `platform` must be a connected platform; only tasks bound to it AND named after it
// are eligible, so a task that merely reaches the platform (catalogue_expansion_opportunities,
// ['etsy','shopify']) is never pulled in by the platform name. Ties across two specialists
// select nothing, exactly like capabilityFallbackTarget above; ties between two tasks of the
// SAME specialist are broken by declared order, the convention used throughout this file.
function platformCapabilityOwner(clauseText, platform) {
  const owners = [];
  for (const specialist of getSpecialistCapabilityRegistry()) {
    let best = null;
    let bestCount = 0;
    for (const task of specialist.supported_tasks) {
      if (!Array.isArray(task.platforms) || !task.platforms.includes(platform)) continue;
      if (!capabilityNameWords(task).has(platform)) continue;
      const count = capabilityNameMatchCount(clauseText, task);
      if (count > bestCount) {
        bestCount = count;
        best = task;
      }
    }
    if (best) owners.push({ id: specialist.id, task: best });
  }
  if (owners.length !== 1) return null;
  const target = ROUTING_TARGETS.find((entry) => entry.type === 'specialist' && entry.id === owners[0].id) || null;
  return target ? { target, task: owners[0].task } : null;
}

function platformNamedCapabilityTarget(clauseText) {
  const platforms = connectedPlatformNamesIn(clauseText);
  if (platforms.length !== 1) return null;
  const [platform] = platforms;
  const resolved = platformCapabilityOwner(clauseText, platform);
  if (!resolved) return null;

  // A specialist the clause names by its OWN name/synonyms outranks the platform pairing.
  const competitor = distinctiveRoute(clauseText);
  if (competitor && competitor.status === 'matched' && competitor.target.type === 'specialist' && competitor.target.id !== resolved.target.id) {
    const synonyms = ROUTING_SYNONYMS[competitor.target.id] || [];
    const ownName = new Set(tokenize(`${competitor.target.id.replace(/_/g, ' ')} ${competitor.target.title} ${synonyms.join(' ')}`));
    if (distinctiveRoutingWords(clauseText, competitor.target).some((word) => ownName.has(word))) return null;
  }
  return resolved;
}

// THE PLATFORM THE OBJECTIVE ALREADY ESTABLISHED, APPLIED TO A CLAUSE THAT NAMES NO PLATFORM.
//
// "Chief, inspect my Etsy store and analyze my current active digital listings." says Etsy once
// and then keeps talking about the same shop. The second clause names no platform, so the rule
// above cannot see it, and "listings" routed it to the Listing specialist - which AUTHORS
// listing copy and cannot read Etsy at all, so it had nothing to run and asked for
// clarification. This is what lets an already-named platform carry across the request.
//
// DELIBERATELY NARROWER THAN IT LOOKS, in three ways:
//   1. It needs exactly ONE connected platform named in the whole objective. "Analyse my Etsy
//      invitation listings and my Shopify products." names two and is untouched.
//   2. Only tasks whose OWN id/title names that platform are eligible. No capability is named
//      after Shopify, so every Shopify objective in the existing corpus is a strict no-op.
//   3. The clause must name that capability. A clause naming neither keeps its existing route.
// The decline guard is deliberately NOT applied here: the platform was established by an
// explicit earlier clause, so the owner is already talking about that store's own records,
// which is a more specific reading than a platform-neutral specialist matched on one word.
function inheritedPlatformCapabilityTarget(clauseText, platform) {
  if (!platform || connectedPlatformNamesIn(clauseText).length > 0) return null;
  return platformCapabilityOwner(clauseText, platform);
}

// The single connected platform an objective names, or null when it names none or several.
function soleObjectivePlatform(routedClauses) {
  const named = new Set();
  for (const clause of routedClauses) {
    for (const platform of connectedPlatformNamesIn(clause.text)) named.add(platform);
  }
  return named.size === 1 ? [...named][0] : null;
}

// A FIELD OF THE ANSWER THAT CAPABILITY ALREADY RETURNS.
//
// "... show me the current shop name, shop ID, listing count, and whether Etsy is connected as
// read-only" is one question with a list of FIELDS. The clause splitter has no grammar, so each
// field arrives as its own clause, and "listing count" then scored 3 for the Listing specialist
// purely because "listing" repeats three times in that specialist's own routing text - selecting
// a second specialist for a word that is a column of the answer the first one already produces.
//
// Judged against the selected capability's OWN declared output_contract.fields, never a word
// list: "listing count" is {listing, count} and etsy_shop_inspection really does return
// listing_active_count and digital_listing_count. Adding a capability widens this automatically,
// and a capability that does not return a field cannot absorb a clause asking for it.
//
// It can only fire inside the same sentence as a clause that platformNamedCapabilityTarget
// already resolved, so "Check my SEO and listing quality" - no platform named anywhere - never
// reaches it and keeps routing "listing quality" to Listing.
function namesOnlyAnswerFields(clauseText, task) {
  const fields = task && task.output_contract && Array.isArray(task.output_contract.fields) ? task.output_contract.fields : [];
  if (fields.length === 0) return false;
  // Split on '_' first: tokenize() keeps underscores, so 'listing_active_count' would stay one
  // token and never match the words an owner actually types.
  const fieldWords = new Set(tokenize(fields.join(' ').replace(/_/g, ' ')).map(singularForm));
  const clauseWords = tokenize(clauseText).map(singularForm);
  return clauseWords.length > 0 && clauseWords.every((word) => fieldWords.has(word));
}

// Resolves every routed clause into the result shape planRouting consumes - matched, ambiguous,
// unmatched (with an optional reason) or absorbed - plus the framing and a per-clause record of
// how the objective was understood.
function resolveObjectiveIntent(routedClauses) {
  const units = [];
  let previous = null;
  // Per SENTENCE, the capability platformNamedCapabilityTarget resolved in it - so a later
  // field clause of the SAME sentence can be recognised as part of that answer. Scoped to the
  // sentence, not the objective, so a second sentence asking for something else is unaffected.
  const sentenceCapabilityTask = {};
  // The one connected platform this objective names, if it names exactly one - so a later
  // clause that names none can still be understood as being about that same store.
  const objectivePlatform = soleObjectivePlatform(routedClauses);
  for (const clause of routedClauses) {
    if (clause.result.status === 'absorbed') {
      units.push({ clause, merged: true });
      continue;
    }
    const sameSentence = previous && previous.clause.sentence === clause.sentence;
    const interpretation = interpretClause(clause.text, {
      previousAct: sameSentence ? previous.interpretation.act : null,
      previousNegated: sameSentence ? Boolean(previous.interpretation.negated) : false,
      // A market name ("Canada") is scope, never an unknown subject.
      knownWord: (word) => isSystemWord(word) || isMarketWord(word),
      systemVocabulary: SYSTEM_VOCABULARY,
    });
    const unit = { clause, interpretation, previous: sameSentence ? previous : null, disposition: null };
    const { act } = interpretation;
    const { result, text } = clause;

    // A list item carried by a negation ("..., or execute any write approval") is something NOT to do:
    // a constraint on the run, never routed to a capability its nouns happen to name.
    // A NEGATED CLAUSE IS A CONSTRAINT WHETHER OR NOT IT CONTINUES ANOTHER ONE. This used to
    // require `continuation` as well, which the HEAD of a negated list never has - so "Do not
    // invent sales" (the head of "Do not invent sales, demand, search volume, or performance
    // metrics.") fell through to routing and selected Analytics on the word "sales", turning
    // the owner's own prohibition into the task they forbade. The same held for every plain
    // "Don't include drafts" clause. interpretClause only ever sets `negated` on an act of
    // 'scope' (an instruction about the answer), so this cannot absorb a request: "Don't
    // change prices, and write new titles" still routes the titles, because that clause opens
    // with a PRODUCE verb and is never negated in the first place.
    if (act === 'safety' || act === 'empty' || interpretation.negated) {
      unit.disposition = { kind: 'constraint' };
    } else if (sameSentence && isMarketListFragment(text)) {
      // "... for Canada and Australia": the splitter cut a list of markets. The fragment is the previous
      // clause's scope - never a request of its own, and never an unknown capability.
      unit.disposition = { kind: 'framing' };
    } else if (act === 'unsupported_platform') {
      // The platform as the owner typed it ("eBay"), falling back to the registry's name.
      const typed = String(text).match(new RegExp(`\\b${interpretation.platform}\\b`, 'i'));
      const name = typed ? typed[0] : interpretation.platform;
      unit.disposition = {
        kind: 'blocked',
        reason: `"${text}" refers to ${name}, which is not a platform connected to this system - please clarify what you need.`,
      };
    } else if (act === 'unsupported_action') {
      unit.disposition = {
        kind: 'blocked',
        reason: `"${text}" asks for something no capability here can do ("${interpretation.verb}") - please clarify what you need.`,
      };
    } else if (act === 'produce' || act === 'change' || act === 'act') {
      // Unchanged from before: the routed clause is the task, and every downstream gate
      // (mutation intent, permissions, compliance, approval, verification, audit) applies.
      unit.disposition = result.status === 'matched' ? { kind: 'task', target: result.target } : { kind: 'unresolved' };
    } else {
      // A capability named together with the platform it is named after identifies the task more
      // precisely than word overlap can, and is checked first. A later clause of the SAME
      // sentence that names only fields that capability already returns is part of its answer.
      const platformCapability = platformNamedCapabilityTarget(text);
      if (platformCapability) {
        sentenceCapabilityTask[clause.sentence] = platformCapability.task;
        unit.disposition = {
          kind: 'task',
          target: platformCapability.target,
          via: 'platform_capability',
          capability: platformCapability.task,
        };
        units.push(unit);
        previous = unit;
        continue;
      }
      // Checked BEFORE the inherited platform below: a field of the answer the sentence's own
      // capability already returns ("listing count" beside an Etsy shop read) is part of that
      // answer, not a second capability naming the same word.
      const answerFieldsOf = sameSentence ? sentenceCapabilityTask[clause.sentence] : null;
      if (answerFieldsOf && namesOnlyAnswerFields(text, answerFieldsOf)) {
        unit.disposition = { kind: 'framing' };
        units.push(unit);
        previous = unit;
        continue;
      }
      const inheritedCapability = inheritedPlatformCapabilityTarget(text, objectivePlatform);
      if (inheritedCapability) {
        sentenceCapabilityTask[clause.sentence] = inheritedCapability.task;
        unit.disposition = {
          kind: 'task',
          target: inheritedCapability.target,
          via: 'inherited_platform_capability',
          capability: inheritedCapability.task,
        };
        units.push(unit);
        previous = unit;
        continue;
      }
      const route = distinctiveRoute(text);
      if (
        route && route.status === 'matched' && route.target.type === 'shared_infrastructure' &&
        result.status === 'matched' && result.target.type === 'specialist'
      ) {
        // Only shared infrastructure had distinctive words, yet the clause as a whole routed to a
        // specialist: the specialist route stands, as it did before.
        unit.disposition = { kind: 'task', target: result.target };
      } else if (route && route.status === 'matched') {
        unit.disposition = { kind: 'task', target: route.target };
      } else if (route) {
        unit.disposition = { kind: 'ambiguous', candidates: route.candidates };
      } else if (result.status === 'matched' && result.target.type === 'specialist' && !refersBack(text)) {
        // A weak match (generic words or the platform name only) that names the owner's own thing
        // ("show me my product data") asks for that data - unless a declared capability names the
        // subject more precisely ("how are my Shopify sales doing" -> sales), checked below. One
        // that refers back ("for each product") is framing.
        unit.disposition = {
          kind: 'framing_candidate',
          weakTarget: result.target,
          weakByPlatformOnly: matchRestsOnPlatformName(text, result.target),
        };
      } else {
        unit.disposition = { kind: 'framing_candidate' };
      }
    }
    units.push(unit);
    previous = unit;
  }

  const live = units.filter((unit) => !unit.merged);
  const firstPassHasTask = live.some((unit) => unit.disposition.kind === 'task' || unit.disposition.weakTarget);

  // Capabilities named by read-type clauses become tasks before anything is absorbed.
  for (const unit of live) {
    if (unit.disposition.kind !== 'framing_candidate') continue;
    // Read-type clauses, and statements of context ("My sales have been flat."), may name a capability.
    const readType = ['inform', 'goal', 'scope'].includes(unit.interpretation.act);
    // A weak route is refined by a named capability only when it rested on the platform name alone.
    const mayRefine = !unit.disposition.weakTarget || unit.disposition.weakByPlatformOnly;
    const fallback = readType && mayRefine ? capabilityFallbackTarget(unit.clause.text, { storeScopedOnly: firstPassHasTask }) : null;
    if (fallback) unit.disposition = { kind: 'task', target: fallback, via: 'capability' };
    else if (unit.disposition.weakTarget) unit.disposition = { kind: 'task', target: unit.disposition.weakTarget };
  }

  const taskUnits = live.filter((unit) => unit.disposition.kind === 'task');
  const plannedKeys = new Set(taskUnits.map((unit) => targetKey(unit.disposition.target)));
  const taskWords = new Set();
  for (const unit of taskUnits) {
    for (const token of interpretationTokens(unit.clause.text)) taskWords.add(singularForm(token.lower));
  }
  const knownWord = (word) => isSystemWord(word) || isMarketWord(word) || taskWords.has(singularForm(String(word).toLowerCase()));

  for (const unit of live) {
    const { kind } = unit.disposition;
    if (kind === 'ambiguous') {
      if (taskUnits.length > 0 && unit.disposition.candidates.every((target) => plannedKeys.has(targetKey(target)))) {
        unit.disposition = { kind: 'framing' };
      } else if (taskUnits.length === 0) {
        unit.disposition = { kind: 'unresolved' };
      }
    } else if (kind === 'framing_candidate') {
      if (taskUnits.length === 0) {
        // Alone, a read-type clause whose only route is infrastructure it never named has no task:
        // it is reported as unmatched rather than run as a configuration/memory/AI step.
        const { result } = unit.clause;
        const unnamedInfrastructure =
          result.status === 'matched' && result.target.type === 'shared_infrastructure' && distinctiveRoutingWords(unit.clause.text, result.target).length === 0;
        unit.disposition = unnamedInfrastructure ? { kind: 'unmatched' } : { kind: 'unresolved' };
        continue;
      }
      const bareContinuation = Boolean(unit.interpretation.continuation) && !(unit.previous && endsInPrepositionalPhrase(unit.previous.clause.text));
      const unrelated = unrelatedNounPhrase(unit.clause.text, knownWord, {
        bareContinuation,
        includePrepositionalObjects: unit.interpretation.act === 'goal',
      });
      unit.disposition = unrelated ? { kind: 'unrelated', phrase: unrelated } : { kind: 'framing' };
    }
  }

  // Nothing is a task and nothing asks a question back: a message made only of constraints
  // ("Do not make any changes.") still asks what to work on.
  const decisive = ['task', 'blocked', 'unrelated', 'ambiguous', 'unresolved', 'unmatched'];
  if (live.length > 0 && !live.some((unit) => decisive.includes(unit.disposition.kind))) {
    live[0].disposition = { kind: 'unresolved' };
    live[0].clause = { ...live[0].clause, result: { status: 'unmatched', segment: live[0].clause.text } };
  }

  const framing = [];
  const resolved = units.map((unit) => {
    const { clause } = unit;
    if (unit.merged) return clause;
    const { kind } = unit.disposition;
    switch (kind) {
      case 'task':
        return {
          ...clause,
          result: {
            status: 'matched',
            segment: clause.text,
            target: unit.disposition.target,
            // The capability this clause named outright, when it named one. Only the two
            // platform rules above set it; every other route leaves it null and the step
            // picks its tool and capability by word overlap exactly as before.
            capability: unit.disposition.capability || null,
          },
        };
      case 'constraint':
        return { ...clause, result: { status: 'absorbed' } };
      case 'framing':
        framing.push(clause.text);
        return { ...clause, result: { status: 'absorbed' } };
      case 'blocked':
        return { ...clause, result: { status: 'unmatched', segment: clause.text, reason: unit.disposition.reason, interpretation_blocked: true } };
      case 'unmatched':
        return { ...clause, result: { status: 'unmatched', segment: clause.text } };
      case 'unrelated':
        return { ...clause, result: { status: 'unmatched', segment: clause.text, interpretation_blocked: true } };
      case 'ambiguous':
        return {
          ...clause,
          result: { status: 'ambiguous', segment: clause.text, candidates: unit.disposition.candidates.map(candidateSummary) },
        };
      default:
        return clause;
    }
  });

  const interpretation = units
    .filter((unit) => !unit.merged)
    .map((unit) => ({
      clause: unit.clause.text,
      act: unit.interpretation.act,
      disposition: unit.disposition.kind === 'unresolved' ? unit.clause.result.status : unit.disposition.kind,
      target: unit.disposition.target ? unit.disposition.target.id : null,
    }));

  return { routedClauses: resolved, framing, interpretation };
}

// Routes a full objective into a controlled, ordered execution plan: splits into
// clauses, routes each one, and combines the results. Any ambiguous or unmatched
// clause stops the whole request and reports a clarification requirement instead of
// guessing at the rest. Matched clauses are deduped by target and ordered to match
// ROUTING_TARGETS's fixed order, so the same objective always produces the same plan.
// CATALOGUE-EXPANSION INTENT GATE
//
// WHY IT EXISTS. Specialist routing below is word-overlap over each specialist's own
// description, which works well for vocabulary-heavy requests ("seo", "advertising",
// "revenue") and badly for a plainly-worded business goal. Measured, before this gate:
//
//   "What should this store sell next?"                     -> analytics_optimization 1, configuration 1
//   "Analyze our existing catalogue and identify expansion
//    opportunities."                                        -> analytics_optimization 0.5
//   "Scan the market for products we could add to our
//    catalogue."                                            -> research 2, product 1
//
// Every one of those is a request to find what this store should SELL NEXT, which the
// Product specialist's catalogue_expansion_opportunities capability exists to answer.
// No amount of re-weighting fixes it: the words that carry the intent ("sell next",
// "add to our catalogue", "related to what we already sell") appear in no specialist
// description, so there is nothing for overlap scoring to find.
//
// WHY IT IS SHAPED LIKE THIS, AND NOT A KEYWORD LIST. A bag of words like
// product/market/opportunity/new would hijack most of Research and Analytics. Each
// pattern below is a PHRASE SHAPE requiring a combination - an expansion action AND the
// store's own catalogue as its object - so "research the market" and "analyze our
// existing catalogue" are untouched.
//
// UNAMBIGUOUS vs SUPPORTING. The first list can mean nothing else, so it fires on its
// own. The second is real but weaker evidence, so it is vetoed by any competitor, SEO,
// listing or advertising vocabulary in the same objective - which is what keeps
// "compare similar products from our competitors" with Research and "which related
// products do competitors rank for" out of Product. Found by adversarial testing: the
// related-products pattern hijacked both before the veto was added.
//
// DETERMINISTIC AND FREE. Pure regex over the objective text - no model call, no
// network, no new tool, and it changes nothing about permissions, budgets, audit or
// compliance. It only decides which EXISTING specialist a clause belongs to.
const CATALOGUE_EXPANSION_UNAMBIGUOUS_PATTERNS = [
  // "what should this store / we sell next"
  /\bwhat\s+(?:products?\s+)?(?:should|could)\s+(?:we|i|this\s+store|our\s+store|the\s+store|you)\s+(?:sell|add|offer|stock|launch)\b/i,
  /\b(?:catalogue|catalog)\s+expansion\b/i,
  /\bexpand(?:ing)?\b[^.?!]{0,30}\b(?:catalogue|catalog|range|product\s+line|assortment|offering)\b/i,
  /\bexpansion\s+opportunit(?:y|ies)\b/i,
  /\b(?:based\s+on|from)\s+what\s+we\s+(?:already\s+)?sell\b/i,
];

const CATALOGUE_EXPANSION_SUPPORTING_PATTERNS = [
  /\bproducts?\b[^.?!]{0,40}\b(?:for\s+(?:us|me|this\s+store)\s+)?to\s+(?:sell|add|offer|stock|launch)\b/i,
  /\bproducts?\b[^.?!]{0,40}\b(?:we\s+(?:could|should|can|might)\s+)?add\b/i,
  /\badd\b[^.?!]{0,40}\b(?:to\s+)?(?:our|the|my|this)\s+(?:catalogue|catalog|store|range|product\s+line|line\s?up|assortment)\b/i,
  /\b(?:related|similar|adjacent|complementary)\s+products?\b/i,
  /\bproducts?\s+related\s+to\b/i,
  /\bnew\s+products?\s+(?:opportunit(?:y|ies)|ideas?)\b/i,
  /\bproduct\s+(?:opportunit(?:y|ies)|ideas?)\b[^.?!]{0,60}\b(?:already\s+sell|existing|our\s+catalogue|our\s+catalog|we\s+sell|this\s+store)\b/i,
];

// Vocabulary that means the objective is about somebody else's products, or about a
// different job on this store's own products. Suppresses the SUPPORTING patterns only.
const CATALOGUE_EXPANSION_VETO_PATTERN =
  /\bcompetitors?\b|\brivals?\b|\bseo\b|\brank(?:s|ing|ed)?\b|\bkeywords?\b|\blistings?\b|\bads?\b|\badvertis\w*\b|\bcampaigns?\b/i;

function hasCatalogueExpansionIntent(text) {
  if (typeof text !== 'string' || text.trim() === '') return false;
  if (CATALOGUE_EXPANSION_UNAMBIGUOUS_PATTERNS.some((pattern) => pattern.test(text))) return true;
  if (CATALOGUE_EXPANSION_VETO_PATTERN.test(text)) return false;
  return CATALOGUE_EXPANSION_SUPPORTING_PATTERNS.some((pattern) => pattern.test(text));
}

// `liveMarketGate: false` reads the objective clause by clause only, without the whole-objective live-market gate.
// The capability named by the most clauses routed to one target, as the {toolId, capabilityId}
// shape buildPlanStep's forcedSelection takes. Ties keep the first named. A task with no tool
// is skipped rather than forced - forcing a capability with nothing to run would replace a
// word-overlap guess with a certainty that cannot execute.
function mostNamedCapability(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return null;
  const counts = new Map();
  for (const task of tasks) {
    if (!task || !Array.isArray(task.tool_ids) || task.tool_ids.length === 0) continue;
    const entry = counts.get(task.id) || { task, count: 0 };
    entry.count += 1;
    counts.set(task.id, entry);
  }
  let best = null;
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  return best ? { toolId: best.task.tool_ids[0], capabilityId: best.task.id } : null;
}

function planRouting(objective, { liveMarketGate = true } = {}) {
  // A NAMED DATA SOURCE THIS SYSTEM DOES NOT HAVE ("Google Trends search volume", "Jungle Scout sales
  // estimates", "AliExpress suppliers") is refused by name before any routing, instead of being routed as
  // ordinary wording into an unrelated capability. Nothing is presented as if that source's data existed.
  const unsupportedSource = unsupportedDataSourceIn(objective);
  if (unsupportedSource) {
    return {
      status: 'clarification_required',
      clarification_type: 'unmatched',
      reason:
        `${unsupportedSource} is not available: no integration for it is connected to this system, so it cannot be retrieved or used, and nothing will be presented as if it were. ` +
        unsupportedDataSourceAlternative(unsupportedSource),
      candidates: null,
      unmatched_segment: objective,
      interpretation_blocked: true,
      unsupported_data_source: unsupportedSource,
    };
  }

  // CATALOGUE-EXPANSION INTENT, checked on the WHOLE objective before clause splitting.
  //
  // Before splitting on purpose: "Analyze our existing catalogue and identify expansion
  // opportunities." is ONE goal, and CLAUSE_SPLIT_REGEX would tear it into an Analytics
  // clause and an orphaned fragment - the same class of problem protectFileFormatLists()
  // already guards against, handled the same way, at the same stage.
  //
  // Only ever routes to a specialist that already exists, and only to the one whose
  // declared remit this is. Everything downstream - capability match, tool selection,
  // permissions, budgets, audit, compliance - runs exactly as it does for any other
  // routed clause. See hasCatalogueExpansionIntent above for why it cannot hijack
  // Research, Analytics, SEO, Listing, Marketing or Advertising.
  // LIVE MARKET RESEARCH (demand, trends, rising, seasonal, fads, in named markets) is answered by the same
  // live research capability: it is the only capability that retrieves market evidence rather than structuring
  // evidence a caller already holds. Store-record trends, competitor questions and supplied trend data are
  // excluded by hasLiveMarketResearchIntent itself and keep their existing routing. A request about an EXISTING
  // proposal is the proposal workflow (agent/core/proposalExecution.js): a market clause inside it is one more
  // request that workflow must report, so the whole objective is not taken over as market research.
  //
  // The live-market gate never swallows a genuinely unknown request: the same objective is first read clause by
  // clause, and a clause no capability matches still asks for clarification. Market names in a list are scope, so
  // they never count as unknown there (see interpretClause and isMarketListFragment).
  const liveMarketResearch =
    liveMarketGate && hasLiveMarketResearchIntent(objective) && !referencesExistingProposal(objective);
  if (hasCatalogueExpansionIntent(objective) || liveMarketResearch) {
    if (!hasCatalogueExpansionIntent(objective)) {
      // A clause no capability matched is part of the market question this gate answers only when it is itself
      // market research, a market list, or a question (act 'inform') in the same sentence as a market-research
      // clause ("Which themes are seasonal, and when do they peak?"). A new action ("then frobnicate the widgets")
      // or an unsupported one is never absorbed.
      const { routedClauses, interpretation } = resolveObjectiveIntent(
        attemptClauseRecovery(splitIntoClauseUnits(objective).map((unit) => ({ text: unit.text, sentence: unit.sentence, result: routeClause(unit.text) })))
      );
      const marketSentences = new Set(routedClauses.filter((clause) => hasLiveMarketResearchIntent(clause.text)).map((clause) => clause.sentence));
      const actOf = (text) => (interpretation.find((entry) => entry.clause === text) || {}).act;
      const partOfMarketQuestion = (clause) =>
        hasLiveMarketResearchIntent(clause.text) ||
        isMarketListFragment(clause.text) ||
        (!clause.result.interpretation_blocked && actOf(clause.text) === 'inform' && marketSentences.has(clause.sentence));
      const unknownClause = routedClauses.find((clause) => clause.result.status === 'unmatched' && !partOfMarketQuestion(clause));
      const unknown = unknownClause ? unknownClause.result : null;
      if (unknown) {
        return {
          status: 'clarification_required',
          clarification_type: 'unmatched',
          reason: unknown.reason || `No known capability matches "${unknown.segment}" - please clarify what you need.`,
          candidates: null,
          unmatched_segment: unknown.segment,
          interpretation_blocked: Boolean(unknown.interpretation_blocked),
          interpretation,
        };
      }
    }
    const productTarget = ROUTING_TARGETS.find(
      (target) => target.type === 'specialist' && target.id === 'product'
    );
    if (productTarget) {
      return { status: 'planned', targets: [productTarget], segments: [objective.trim()] };
    }
  }

  const clauses = splitIntoClauseUnits(objective);

  if (clauses.length === 0) {
    return {
      status: 'clarification_required',
      clarification_type: 'unmatched',
      reason: 'The task is too short to act on.',
      candidates: null,
      unmatched_segment: objective,
    };
  }

  // Route every clause independently first, then give attemptClauseRecovery() a
  // chance to fold a clause that matched nothing back into an adjacent one before any
  // clarification decision is made - see that function's own header above.
  // Then resolveObjectiveIntent() decides, for the objective as a whole, which clauses are the
  // business task and which are framing, scope, constraints or unsupported requests.
  const { routedClauses, framing, interpretation } = resolveObjectiveIntent(
    attemptClauseRecovery(clauses.map((unit) => ({ text: unit.text, sentence: unit.sentence, result: routeClause(unit.text) })))
  );

  const orderedEntries = [];
  const seen = new Set();

  for (const { result } of routedClauses) {
    if (result.status === 'absorbed') continue;

    if (result.status === 'unmatched') {
      return {
        status: 'clarification_required',
        clarification_type: 'unmatched',
        reason: result.reason || `No known capability matches "${result.segment}" - please clarify what you need.`,
        candidates: null,
        unmatched_segment: result.segment,
        // Set when the clause was understood and is unsupported (an action or platform this
        // system does not have, or an unrelated subject) - not a segmentation problem, so
        // runOrchestratorContract does not ask the AI to re-segment it.
        interpretation_blocked: Boolean(result.interpretation_blocked),
        interpretation,
      };
    }

    if (result.status === 'ambiguous') {
      return {
        status: 'clarification_required',
        clarification_type: 'ambiguous',
        reason: `"${result.segment}" could belong to more than one capability - please clarify which one you mean.`,
        candidates: result.candidates,
        unmatched_segment: null,
        interpretation,
      };
    }

    const key = `${result.target.type}:${result.target.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      orderedEntries.push({ target: result.target, segment: result.segment, capabilities: [] });
    }
    // Every capability the clauses routed to this target named outright. The segment stays the
    // FIRST matching clause, unchanged - but a request whose later clauses all name one
    // capability ("analyze my current active digital listings", "show the listing title")
    // should not be answered by whichever tool the first clause's wording happened to score.
    if (result.capability) {
      orderedEntries.find((entry) => `${entry.target.type}:${entry.target.id}` === key).capabilities.push(result.capability);
    }
  }

  orderedEntries.sort((a, b) => ROUTING_TARGETS.indexOf(a.target) - ROUTING_TARGETS.indexOf(b.target));

  return {
    status: 'planned',
    targets: orderedEntries.map((entry) => entry.target),
    // Parallel to `targets` - the clause text that matched each target, so a plan
    // step's current_task can be the specific piece of the request it's handling
    // rather than the whole objective. See agent/core/executionState.js.
    segments: orderedEntries.map((entry) => entry.segment),
    // Parallel to `targets` too - the capability this target's clauses NAMED, when they named
    // one, as {tool_id, capability_id}; null otherwise, which is every objective that does not
    // name a platform-bound capability by name. The most-named capability wins a disagreement
    // (a request that says "listings" three times and "store" once is about the listings);
    // ties keep the first, the declared-order convention used throughout this file.
    // runOrchestratorContract passes it to buildPlanStep as forcedSelection, where it is still
    // checked against that step's own post-gate candidate list - so it can never reach a tool
    // the mutation-intent gate, the platform filter or the specialist's own ownership excluded.
    capabilities: orderedEntries.map((entry) => mostNamedCapability(entry.capabilities)),
    // What the parser recognised as how-to-answer framing and as run-wide safety
    // constraints. Informational: neither adds a target, and every step still receives the
    // whole objective.
    instructions: { framing, safety: collectSafetyConstraints(objective) },
    // How each clause was understood (act and disposition) - informational, for audit and tests.
    interpretation,
  };
}

// Which researchParams field a multi-capability tool reads to select its capability,
// and (only where the tool's own value differs from the specialistCapabilityRegistry
// capability id - customer_research alone) how to translate one into the other.
// Without this, a matched capability (see matchedCapability below) is purely
// descriptive - the tool would silently keep running its own hardcoded default
// capability regardless of what was actually matched, discarding the capability-level
// routing this pipeline just did. null valueMap means the capability id itself is
// already the value the tool expects (verified directly against each tool's own
// destructuring default - see tools/analyticsTool.js, tools/seoAnalysisTool.js,
// tools/keywordResearchTool.js, tools/marketingAnalysisTool.js,
// tools/listingContentTool.js, tools/customerResearchTool.js,
// tools/socialContentTool.js, tools/paidAdvertisingTool.js,
// tools/productResearchTool.js).
const TOOL_CAPABILITY_SELECTORS = {
  customer_research: {
    field: 'customerResearchMode',
    valueMap: { customer_market_intelligence: 'segment_research', customer_segmentation: 'customer_segmentation' },
  },
  research_analysis: { field: 'researchType', valueMap: null },
  product_research: { field: 'productCapability', valueMap: null },
  keyword_research: { field: 'seoCapability', valueMap: null },
  seo_analysis: { field: 'seoCapability', valueMap: null },
  listing_content_generation: { field: 'listingCapability', valueMap: null },
  marketing_analysis: { field: 'marketingCapability', valueMap: null },
  social_content_planning: { field: 'socialPlatform', valueMap: null },
  paid_advertising_planning: { field: 'adPlatform', valueMap: null },
  analytics: { field: 'analyticsCapability', valueMap: null },
  analytics_data_retrieval: { field: 'analyticsCapability', valueMap: null },
};

function deriveCapabilitySelectorContext(toolId, capabilityId) {
  const selector = TOOL_CAPABILITY_SELECTORS[toolId];
  if (!selector) return {};
  const value = selector.valueMap ? selector.valueMap[capabilityId] : capabilityId;
  return value ? { [selector.field]: value } : {};
}

// DERIVE MARKETS FROM APPROVED BUSINESS CONFIGURATION: global_market_opportunity_analysis
// (agent/core/specialistCapabilityRegistry.js) requires a caller-supplied `markets` array,
// but a free-text objective alone can never supply one, and no live Shopify data source
// exists for "markets" the way tools/productDataRetrievalTool.js exists for products (see
// this file's own "Genuinely unobtainable capabilities" comment above). configuration/
// business.yaml's owner-confirmed `countries` field already answers exactly this
// question - previously loaded only by server.js's /ask chat-context string, never
// connected to this dispatch pipeline. Reuses tools/configValidator.js's
// loadBusinessConfig() unchanged (no new YAML-parsing logic). Pure pass-through of
// approved text (only the trailing "(primary)"/"(secondary)" qualifier is stripped) -
// never invents a market, never computes anything. Scoped narrowly to this one
// capability id: no other specialist's required field maps to any business.yaml field
// the same way (see the Phase 1 real-world-testing investigation this fix came from).
// Returns {} - never throws - when business.yaml is missing, incomplete, unparsable, or
// has no countries, so the existing requiredEvidenceMissing clarification stop is
// completely unchanged in that case (ask the user only when no real business context
// exists).
const BUSINESS_CONFIG_PATH = path.join(__dirname, '..', '..', 'configuration', 'business.yaml');

function stripMarketQualifier(value) {
  return value.replace(/\s*\((?:primary|secondary)\)\s*$/i, '').trim();
}

// A second capability now maps to a business.yaml field the same way: content_calendar's
// `dailyContentUnits` is exactly configuration/business.yaml's
// social_content.daily_content_units - the business's own organic daily content-unit
// target, which a free-text objective can never supply either. Read through
// agent/core/contentCadencePolicy.js's own readDailyContentUnitsTarget() rather than
// reaching into the config shape here, so there is one place that decides what a usable
// target is. Same honest failure mode as markets above: {} when business.yaml is
// missing, unparsable, or has no target, in which case the calendar simply reports no
// cadence at all rather than being measured against an invented number.
function deriveBusinessConfigContext({ toCapabilityId, configPath = BUSINESS_CONFIG_PATH }) {
  if (toCapabilityId !== 'global_market_opportunity_analysis' && toCapabilityId !== 'content_calendar') return {};

  let businessConfig;
  try {
    businessConfig = loadBusinessConfig(configPath);
  } catch (err) {
    return {};
  }

  if (toCapabilityId === 'content_calendar') {
    const dailyContentUnits = readDailyContentUnitsTarget(businessConfig);
    return dailyContentUnits === null ? {} : { dailyContentUnits };
  }

  const countries = Array.isArray(businessConfig.countries) ? businessConfig.countries : [];
  const markets = countries
    .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
    .map((entry) => {
      const market = stripMarketQualifier(entry);
      return { market, country: market };
    })
    .filter((entry) => entry.market !== '');

  return markets.length > 0 ? { markets } : {};
}

// True when every TOP-LEVEL name in inputContract.required is present and non-empty in
// params - e.g. 'entries[].productIdentity' is checked only as its base key 'entries'
// (whether that array's entries each carry productIdentity is the tool's own,
// authoritative validation to make, not a second, less precise copy of it here). An
// empty `required` array (nothing is required) always passes. Deliberately a coarser,
// deterministic pre-check, not a replacement for the tool's own validation - it exists
// only to decide whether dispatching is even worth attempting, never to approve/deny a
// value's actual correctness.
// DECLARED BATCH FORM: when a contract lists a required field `x` AND an optional `xs`, a
// non-empty `xs` array is the same real evidence for several subjects (seo_quality_check's
// listingRecords - one record per real store product). Only a form the capability itself
// declares counts; nothing is inferred for any other field.
function requiredFieldPresent(field, inputContract, params) {
  const isPresent = (value) =>
    Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== '';
  if (!params || typeof params !== 'object') return false;
  if (isPresent(params[field])) return true;
  const batchField = `${field}s`;
  const optional = inputContract && Array.isArray(inputContract.optional) ? inputContract.optional : [];
  return optional.includes(batchField) && Array.isArray(params[batchField]) && params[batchField].length > 0;
}

function topLevelRequiredFieldsSatisfied(inputContract, params) {
  const required = inputContract && Array.isArray(inputContract.required) ? inputContract.required : [];
  if (required.length === 0) return true;
  if (!params || typeof params !== 'object') return false;
  const topLevelFields = new Set(required.map((field) => field.split(/[.[]/)[0]));
  for (const field of topLevelFields) {
    if (!requiredFieldPresent(field, inputContract, params)) return false;
  }
  return true;
}

// Scores a piece of candidate text against an already-tokenized objective word set -
// the same word-overlap approach used throughout this file (identifyRequiredCapability,
// scoreRoutingTargets), factored into one place so buildPlanStep's tool and capability
// matching below don't each duplicate it.
function scoreWordOverlap(text, objectiveWords) {
  let score = 0;
  for (const word of tokenize(text)) {
    if (objectiveWords.has(word)) score += 1;
  }
  return score;
}

// Finds, among a list of capability tasks, the one whose own id/title/description
// best matches the objective's wording - ties broken by declared order (first wins).
// Returns null when the list is empty; never guesses among equally-scored candidates
// beyond that deterministic, documented tie-break. This declared-order tie-break is
// intentional and relied on elsewhere (e.g. Social & Advertising's 5 platform
// capabilities, which legitimately tie whenever no platform name appears in the
// objective - see this file's own tests) - it is left unchanged here. See
// isAmbiguousCapabilityMatch below for the narrower, Listing-only confidence check.
function bestMatchingTask(tasks, objectiveWords) {
  let best = null;
  let bestScore = -1;
  for (const task of tasks) {
    const score = scoreWordOverlap(`${task.id} ${task.title} ${task.description}`, objectiveWords);
    if (score > bestScore) {
      bestScore = score;
      best = task;
    }
  }
  return best;
}

// LISTING-ONLY SAFETY CHECK: true when none of the given capability tasks was a
// confident, distinguishing match for the objective - a tie for the top score, or a
// top score of 0 (no real word overlap at all). Scoped to Listing specifically (see
// buildPlanStep's call site) rather than changing bestMatchingTask's general
// declared-order tie-break for every specialist, because that broader change was
// verified to regress other specialists' own legitimate, already-correct tie-break
// cases (e.g. Social & Advertising's 5 platform capabilities - see this file's own
// tests). Listing's two capabilities (listing_content, marketplace_format) both
// require a specific product and neither is a safe default to silently run when the
// objective's wording gave no real signal for either one - see the bug this guards
// against: "identify the single most important improvement opportunity for my
// Shopify product listings" tied 1-1 on the incidental word "product" and was
// silently dispatched as listing_content, failing on a misleading "missing
// productReference" error instead of asking which action was actually intended.
function isAmbiguousCapabilityMatch(tasks, objectiveWords) {
  if (!Array.isArray(tasks) || tasks.length === 0) return false;
  let bestScore = -1;
  let tiedCount = 0;
  for (const task of tasks) {
    const score = scoreWordOverlap(`${task.id} ${task.title} ${task.description}`, objectiveWords);
    if (score > bestScore) {
      bestScore = score;
      tiedCount = 1;
    } else if (score === bestScore) {
      tiedCount += 1;
    }
  }
  return bestScore <= 0 || tiedCount > 1;
}

// Builds and executes one plan step for a routed target, reusing the existing
// single-capability pipeline (createExecutionRequest, selectSpecialist,
// gatherMinimumContext, executeSelectedCapability, validateResult) unchanged, and
// returns it as a shared execution state (agent/core/executionState.js) rather than
// an ad hoc object - one minimal, self-contained state per specialist, so nothing
// from this step leaks into any other step's state.
//
// CONNECTION TO THE SPECIALIST CAPABILITY REGISTRY: for a specialist target, which
// tools are even candidates comes from agent/core/specialistCapabilityRegistry.js's
// required_tools (itself derived from toolPermissions.js's SPECIALIST_TO_CATEGORIES -
// not a separate source of truth). Once a tool is matched, the registry's
// supported_tasks tells us which declared capability that tool actually serves - the
// explicit "Specialist -> Tool(s)" step this pipeline is required to make visible, not
// just a bare tool id. For a shared-infrastructure target (no specialist owns it),
// candidates come directly from tools/toolRegistry.js's own category, unchanged.
// Finds the best-scoring tool among the candidates; if none scores, reports an honest
// not_available outcome rather than inventing a tool call.
async function buildPlanStep(
  target,
  objective,
  currentTask,
  runTokenTracker = { tokensUsedThisRun: 0 },
  researchParams = null,
  priorSteps = [],
  runApprovalTracker = { requests: [] },
  runAuditTracker = null,
  runToolResultCache = null,
  runUsageTracker = null,
  businessId = null,
  runUsageLedger = null,
  // Optional { toolId, capabilityId } - lets a deliberate, explicitly-sequenced
  // caller (agent/core/growthWorkflowOrchestrator.js) pin exactly which tool/
  // capability this step runs, bypassing the word-overlap scoring below. Free-text
  // routing (runOrchestratorContract) never supplies this, so its behavior is
  // unchanged. The forced tool must still be a real candidate for this target
  // (checked below) - forcing never lets a step execute a tool outside the target's
  // own real ownership.
  forcedSelection = null,
  // Optional {relevant_memory: [...]} - this business's own already-verified/approved
  // memory records (see agent/core/memoryContextRetrieval.js's getRelevantMemoryContext),
  // computed ONCE per run by runOrchestratorContract and threaded into every step the
  // same way (never re-fetched per step). null for every caller that doesn't compute
  // it (growthWorkflowOrchestrator.js, optimizationCycleOrchestrator.js, server.js's
  // /run) - merged in below exactly like every other derived context source, so
  // omitting it reproduces today's exact behavior unchanged.
  relevantMemoryContext = null
) {
  const capabilityEntry = target.type === 'specialist' ? getSpecialistCapabilityById(target.id) : null;
  appendAuditEvent(runAuditTracker, {
    type: 'agent',
    specialistId: target.type === 'specialist' ? target.id : null,
    capabilityId: null,
    summary:
      target.type === 'specialist'
        ? `Routed clause "${currentTask}" to specialist '${target.id}'.`
        : `Routed clause "${currentTask}" to shared infrastructure '${target.id}'.`,
  });
  appendUsageEvent(runUsageLedger, {
    category: 'agent_task',
    specialistId: target.type === 'specialist' ? target.id : null,
    quantity: 1,
    summary:
      target.type === 'specialist'
        ? `Routed clause "${currentTask}" to specialist '${target.id}'.`
        : `Routed clause "${currentTask}" to shared infrastructure '${target.id}'.`,
  });
  const rawCandidateToolIds = capabilityEntry
    ? capabilityEntry.required_tools
    : target.type === 'shared_infrastructure'
      ? getToolsByCategory(target.id).map((tool) => tool.id)
      : [];

  // GATE 2 OF 3: the same mutation-intent gate on the path the live orchestrator
  // actually uses. The Product specialist legitimately owns the three correction tools
  // alongside its read tools (specialistCapabilityRegistry.js's required_tools), so
  // scoring a read-only clause against that list reproduces the same defect gate 1
  // closes on the legacy path - measured: "Check my Shopify products for vendor
  // mismatches" scored shopify_vendor_correction 9 to product_data_retrieval 2.
  //
  // Classified on currentTask, not the whole objective, because currentTask is the
  // single clause this step is routing, and planRouting has already split a compound
  // request into clauses. So "Analyze the catalogue and fix the vendor on X" still
  // reaches the correction tool through its own unambiguous "fix ..." clause, while the
  // "Analyze ..." clause cannot. A forcedSelection from a deliberately-sequenced caller
  // is checked below against this same filtered list, so it cannot route around the gate
  // either.
  const intentToolIds = filterToolCandidatesByIntent(rawCandidateToolIds, currentTask);

  // THE PLATFORM THE CLAUSE ITSELF NAMES - an additional narrowing of the same candidate list,
  // applied after the mutation-intent gate above and independent of it (it can only remove
  // candidates, never restore one that gate took out).
  //
  // agent/core/toolPermissions.js's PLATFORM_GATE_RULE already refuses a tool bound to a
  // platform the BUSINESS has not enabled. That is a different question from this one, and it
  // cannot answer this one: a business with both platforms enabled passes the gate for every
  // tool, so nothing stopped a clause about Etsy from being answered with a live SHOPIFY read
  // (measured: "inspect my connected Etsy store" selected analytics_data_retrieval, platforms
  // ['shopify']) - or, in the other direction, "Look through my Shopify data ..." from
  // selecting etsy_shop_data_retrieval, whose description mentions Shopify only to say its
  // records are never merged with it.
  //
  // So when the clause NAMES connected platforms, a tool bound to a different platform is not
  // a candidate for it. Platform-neutral tools (platforms: []) are always kept - they compose
  // what a caller supplies and reach no store - and a clause naming no platform filters nothing,
  // which is every existing objective's behavior unchanged. This only ever NARROWS the list the
  // scoring below chooses from; it can never introduce a tool outside this specialist's own
  // required_tools, and it makes no approval, permission or execution decision of its own.
  const namedPlatforms = connectedPlatformNamesIn(currentTask);
  const candidateToolIds =
    namedPlatforms.length === 0
      ? intentToolIds
      : intentToolIds.filter((toolId) => {
          const tool = getToolById(toolId);
          if (!tool || !Array.isArray(tool.platforms) || tool.platforms.length === 0) return true;
          return tool.platforms.some((platform) => namedPlatforms.includes(platform));
        });

  // Tool/capability word-overlap scoring is deliberately based on this step's OWN
  // clause (currentTask) rather than the full, possibly multi-clause `objective`.
  // planRouting/routeClause already split a multi-clause objective and routed each
  // clause to its own target; `currentTask` is that clause's own text (see
  // runOrchestratorContract's buildPlanStep call site, which passes
  // routingResult.segments[i] - the specific clause matched to this target - while
  // `objective` stays the full original text purely so executionRequest.objective/
  // the tools that read it as free-text instruction - ai_reasoning_completion,
  // live_competitor_research - still see the caller's complete original wording).
  // Scoring against the full objective let vocabulary from an EARLIER clause routed
  // to a DIFFERENT specialist leak into THIS step's tool/capability match (e.g. an
  // unrelated Product clause's "opportunity" hijacking a Marketing clause's
  // capability pick toward marketing_opportunity_ranking - see this file's own git
  // history/verification/testing/orchestratorExecutionContract.test.js's
  // cross-clause-isolation regression test). Every existing caller of buildPlanStep
  // besides runOrchestratorContract's multi-clause loop (server.js's single-objective
  // /run, agent/core/growthWorkflowOrchestrator.js, agent/core/
  // optimizationCycleOrchestrator.js) already passes the SAME string for both
  // `objective` and `currentTask`, so this is a no-op for all of them - only the
  // multi-clause routing path's per-step scoring actually changes.
  const objectiveWords = new Set(tokenize(currentTask));
  let toolMatch = null;

  if (forcedSelection && forcedSelection.toolId && candidateToolIds.includes(forcedSelection.toolId)) {
    toolMatch = getToolById(forcedSelection.toolId) || null;
  }

  // live_competitor_research is deliberately EXCLUDED from this word-overlap
  // competition (never a candidate here, only via forcedSelection above or the "LIVE
  // WEB COMPETITOR RESEARCH" block below): its own title/description inevitably
  // repeat "competitor"/"research" (the same vocabulary competitor_research and
  // market_research already compete on), and empirically it can outscore both of them
  // on real objective wording purely from that repetition, hijacking matchedCapability
  // away from an unrelated capability (verified directly - this would have changed
  // verification/testing/orchestratorExecutionContract.test.js's pinned "market
  // competitor research" -> tool_id 'market_research' outcome before this exclusion
  // was added). Calibrating its wording to always score lower is fragile and would
  // need re-verifying against every future objective; excluding it from scoring
  // entirely is robust by construction. It still gets picked, but only through the
  // narrow, capability-gated swap below - never by winning this word-overlap contest.
  //
  // catalogue_expansion_opportunities is excluded for the IDENTICAL reason, verified the
  // same way. Its subject matter is "which products should this store add", so its own
  // wording unavoidably repeats market/opportunity/research/product - the exact vocabulary
  // market_research, global_market_research and global_market_opportunity_analysis already
  // compete on - and it empirically outscored ALL of them on real objective wording purely
  // from that repetition (it changed this file's pinned "market competitor research" ->
  // 'market_research' and "Research the best market opportunity ..." ->
  // 'global_market_opportunity_analysis' outcomes before this exclusion was added, and
  // renaming it to avoid the collision did not fix that). It is reached only through the
  // narrow, capability-gated swap below, or through forcedSelection - never by winning
  // this contest.
  //
  // shopify_product_seo_update is excluded for a different reason: it has nothing to score on. Its
  // values come only from an existing proposal, which proposalExecution.js resolves before routing, so
  // winning a word-overlap contest could only ever produce a request its own source gate refuses.
  const NON_SCORABLE_TOOL_IDS = new Set(['live_competitor_research', 'catalogue_expansion_opportunities', 'shopify_product_seo_update']);
  const scorableToolIds = candidateToolIds.filter((toolId) => !NON_SCORABLE_TOOL_IDS.has(toolId));

  if (!toolMatch) {
    let bestScore = 0;
    let tied = [];
    for (const toolId of scorableToolIds) {
      const tool = getToolById(toolId);
      if (!tool) continue;
      const score = scoreWordOverlap(`${tool.id} ${tool.title} ${tool.description} ${tool.category}`, objectiveWords);
      if (score > bestScore) {
        bestScore = score;
        tied = [tool];
      } else if (score === bestScore && score > 0) {
        tied.push(tool);
      }
    }
    // A TOP-SCORE TIE PREFERS A TOOL THIS SPECIALIST ACTUALLY DECLARES A CAPABILITY FOR.
    //
    // required_tools is derived from the whole tool CATEGORY (buildEntry in
    // specialistCapabilityRegistry.js), so a specialist owns tools that no capability of its
    // own consumes - that registry names the remaining ones itself. Such an orphan can win a
    // word-overlap tie and then leave matchedCapability null, producing a tool call with no
    // declared capability behind it. Measured: 'inspect my connected Etsy store' tied
    // etsy_shop_data_retrieval and etsy_listing_data_retrieval 4-4, on nothing but the words
    // "etsy" and "connected", with the winner decided purely by tools/toolRegistry.js
    // declaration order - so reordering that file would silently have changed which Etsy read
    // ran. Preferring the tool with a declared capability makes that outcome structural.
    // Ties that this does not resolve keep the existing declared-order tie-break (first wins).
    if (tied.length > 1 && capabilityEntry) {
      const withCapability = tied.filter((tool) =>
        capabilityEntry.supported_tasks.some((task) => task.tool_ids.includes(tool.id))
      );
      if (withCapability.length > 0) tied = withCapability;
    }
    toolMatch = tied.length > 0 ? tied[0] : null;
  }

  // No tool scored against the objective's own wording, but at least one candidate
  // exists for this target - fall back to the first one so execution can still report
  // an honest, specific status (e.g. not_available) instead of a generic "no tool".
  if (!toolMatch && scorableToolIds.length > 0) {
    toolMatch = getToolById(scorableToolIds[0]) || null;
  }

  const matchedCategory = toolMatch ? toolMatch.category : null;

  // Which declared capability (agent/core/specialistCapabilityModel.js's
  // CAPABILITY_TASK_FIELDS shape) the matched tool actually serves - null (never
  // guessed) when the tool serves zero capabilities in the registry, or when this
  // target has no capability entry at all (shared infrastructure).
  let matchedCapability = null;
  // Set only when there WAS at least one real candidate task for this tool but
  // bestMatchingTask couldn't confidently pick one (a tie, or zero real word-overlap
  // signal) - see buildPlanStep's dispatch branches below, which stop for
  // clarification in this case instead of silently running whichever task happens to
  // be declared first. Left null (and existing behavior unchanged) for the separate,
  // pre-existing case of a tool with zero connected supported_tasks at all (e.g.
  // product_research) - that is "genuinely nothing to pick from", not "ambiguous".
  let ambiguousCapabilityTasks = null;
  if (capabilityEntry && toolMatch) {
    const candidateTasks = capabilityEntry.supported_tasks.filter((task) => task.tool_ids.includes(toolMatch.id));
    if (forcedSelection && forcedSelection.capabilityId) {
      matchedCapability = candidateTasks.find((task) => task.id === forcedSelection.capabilityId) || null;
    } else if (target.id === 'listing' && isAmbiguousCapabilityMatch(candidateTasks, objectiveWords)) {
      ambiguousCapabilityTasks = candidateTasks;
    } else {
      matchedCapability = bestMatchingTask(candidateTasks, objectiveWords);
    }
  }

  // PREFER REAL DATA OVER NO DATA: plain word-overlap scoring has no notion of "which
  // candidate tool can actually produce evidence" - it can settle on a caller-evidence-
  // only tool (e.g. 'analytics', composing a record from CALLER-SUPPLIED evidence only
  // - see tools/analyticsTool.js) purely because its wording ties with a live,
  // self-sufficient alternative, even when this call has no caller-supplied evidence to
  // hand the former at all. Deterministic and declarative (generalized from an earlier
  // analytics-only special case - see agent/core/specialistCapabilityRegistry.js's
  // live_data_tool_id field, this file's own git history, and
  // verification/testing/orchestratorExecutionContract.test.js's "TEST B"): only swaps
  // when the matched capability itself declares a live_data_tool_id that is (a) also
  // present in that capability's own tool_ids (never a tool this capability doesn't
  // actually support) and (b) a real candidate for this target
  // (candidateToolIds.includes(...) - never a tool outside this specialist's own
  // required_tools). For today's registry this covers exactly the same 4 analytics
  // snapshot tasks (sales/products/customers/inventory) the old hardcoded check did -
  // analytics behavior is unchanged - plus it now automatically applies to any future
  // capability declaring the same shape (e.g. product_discovery, whose only tool_ids
  // entry already IS its live source, so this block is simply a no-op for it - no
  // separate tool competes for that capability to be overridden away from). A caller
  // who DID supply real research input is never overridden. Never fabricates data
  // either way: every live_data_tool_id tool reports its own honest 'failed'/'empty'
  // status (with a clear reason) when it can't actually retrieve something, exactly
  // like every other tool in TOOL_EXECUTORS.
  const hasCallerResearchParams =
    researchParams && typeof researchParams === 'object' && Object.keys(researchParams).length > 0;
  if (
    toolMatch &&
    matchedCapability &&
    matchedCapability.live_data_tool_id &&
    matchedCapability.tool_ids.includes(matchedCapability.live_data_tool_id) &&
    candidateToolIds.includes(matchedCapability.live_data_tool_id) &&
    toolMatch.id !== matchedCapability.live_data_tool_id &&
    !hasCallerResearchParams &&
    !(forcedSelection && forcedSelection.toolId)
  ) {
    toolMatch = getToolById(matchedCapability.live_data_tool_id) || toolMatch;
  }

  // CROSS-CAPABILITY LIVE-DATA FALLBACK: the override above only ever swaps between
  // two tools serving the SAME capability (the analytics case). It cannot help a
  // capability like market_product_opportunity_analysis, whose own live_data_tool_id
  // is null because no live source produces its required marketRow, even when this
  // specialist's OTHER candidate tools include a live source for a DIFFERENT
  // capability (e.g. product_discovery, live_data_tool_id: 'product_data_retrieval')
  // and plain word-overlap happened to prefer the unobtainable one purely because its
  // description repeats matching words more (verified empirically:
  // market_product_opportunity_analysis scores 8 against "identify the single best
  // product opportunity..." vs product_data_retrieval's 3, from description
  // length/repetition, not real relevance - see this file's own git history).
  //
  // Deterministic and narrow: only fires when the override above did NOT already
  // redirect (the matched capability has no live counterpart of its own), no caller
  // evidence was supplied, and some OTHER task this same specialist could also run
  // declares a live_data_tool_id that is a real candidate for this target
  // (candidateToolIds.includes(...) - never a tool outside this specialist's own
  // required_tools). Driven purely by the declarative live_data_tool_id metadata
  // already on the registry - no specialist/capability id is hardcoded, so this
  // generalizes to any future capability with the same shape. Ties broken by declared
  // order (first wins), the same convention used throughout this file. A capability
  // with NO capability match at all (matchedCapability null - e.g. product_research,
  // which has zero connected supported_tasks) is unaffected, preserving its existing
  // honest capability_id: null behavior. Genuinely unobtainable capabilities (no
  // sibling has a live source at all - Research/SEO/Marketing/Social) are unaffected
  // too: this simply finds nothing and falls through to buildPlanStep's
  // requiredEvidenceMissing clarification stop exactly as before. Never fabricates
  // data: the sibling's own live tool still reports its own honest 'failed'/'empty'
  // status when it can't actually retrieve something.
  if (
    toolMatch &&
    matchedCapability &&
    !matchedCapability.live_data_tool_id &&
    capabilityEntry &&
    !hasCallerResearchParams &&
    !(forcedSelection && forcedSelection.toolId)
  ) {
    const liveSiblingTask = capabilityEntry.supported_tasks.find(
      (task) =>
        task.live_data_tool_id &&
        task.live_data_tool_id !== toolMatch.id &&
        candidateToolIds.includes(task.live_data_tool_id)
    );
    if (liveSiblingTask) {
      toolMatch = getToolById(liveSiblingTask.live_data_tool_id) || toolMatch;
      matchedCapability = liveSiblingTask;
    }
  }

  // LIVE WEB COMPETITOR RESEARCH: a narrow, explicitly-scoped special case -
  // deliberately NOT expressed via the generic live_data_tool_id/CROSS-CAPABILITY
  // LIVE-DATA FALLBACK mechanism above (see
  // agent/core/specialistCapabilityRegistry.js's competitor_research task, which
  // leaves live_data_tool_id null on purpose). Reusing that generic mechanism here
  // would also make live_competitor_research a fallback donor for every OTHER Research
  // capability with no live source of its own (market_research, customer_research,
  // ...) via the block just above - wrongly substituting real competitor data for an
  // unrelated research type just because it happens to be the only live source in this
  // specialist's tool set (this would have broken
  // verification/testing/orchestratorExecutionContract.test.js's pinned "market
  // competitor research" -> tool_id 'market_research' tests - verified directly against
  // them before choosing this narrower shape instead). This block only ever swaps to
  // live_competitor_research once routing has already resolved specifically to the
  // competitor_research capability itself, exactly like tools/webCompetitorResearchTool.js's
  // own header explains. Never fabricates data either way: live_competitor_research
  // reports its own honest 'failed'/'empty' status when it can't actually verify a real
  // competitor, exactly like every other tool in TOOL_EXECUTORS.
  const isCompetitorLiveDispatch =
    Boolean(toolMatch) &&
    Boolean(matchedCapability) &&
    matchedCapability.id === 'competitor_research' &&
    candidateToolIds.includes('live_competitor_research') &&
    !hasCallerResearchParams &&
    !(forcedSelection && forcedSelection.toolId);
  if (isCompetitorLiveDispatch && toolMatch.id !== 'live_competitor_research') {
    toolMatch = getToolById('live_competitor_research') || toolMatch;
  }

  // CATALOGUE EXPANSION: reached by CAPABILITY wording, never by tool wording.
  //
  // Its tool is excluded from the word-overlap contest above (see NON_SCORABLE_TOOL_IDS)
  // because the tool's own subject matter unavoidably repeats market/opportunity/research
  // and hijacks every sibling. But it also shares its tool with no other capability, so the
  // ordinary "match a tool, then find its capability" path can never reach it either -
  // leaving it dispatchable only by forcedSelection, which free-text routing never supplies.
  //
  // So it is matched one level up, where the wording IS distinctive: the capability's own
  // description ("what should this store sell next", catalogue, expansion, adjacent,
  // shortlist) is scored against every OTHER capability this specialist declares, and it
  // wins only by beating all of them outright. Verified against the pinned objectives this
  // file's tests protect: "market competitor research" and "Research the best market
  // opportunity for my ecommerce products." do not rank it at all, while "what should this
  // store sell next" does. A tie is not enough - a strict win is required, so an ambiguous
  // clause keeps its existing routing rather than being pulled into expensive research.
  const isForcedElsewhere = Boolean(forcedSelection && forcedSelection.toolId);
  if (!isForcedElsewhere && capabilityEntry && candidateToolIds.includes('catalogue_expansion_opportunities')) {
    let expansionScore = -1;
    let bestOtherScore = -1;
    for (const task of capabilityEntry.supported_tasks) {
      const score = scoreWordOverlap(`${task.id} ${task.title} ${task.description}`, objectiveWords);
      if (task.id === 'catalogue_expansion_opportunities') expansionScore = score;
      else if (score > bestOtherScore) bestOtherScore = score;
    }
    // Fires on a strict score win OR when the objective's own wording carries clear
    // catalogue-expansion intent (hasCatalogueExpansionIntent - the SAME deterministic
    // gate that chose this specialist). One definition of the intent, consulted at both
    // levels: without this, "Find products related to my existing products." reached the
    // Product specialist and then picked product_data_retrieval, answering "what do we
    // already sell" instead of "what should we sell next".
    if ((expansionScore > 0 && expansionScore > bestOtherScore) || hasCatalogueExpansionIntent(currentTask) || hasLiveMarketResearchIntent(currentTask)) {
      toolMatch = getToolById('catalogue_expansion_opportunities') || toolMatch;
      matchedCapability =
        capabilityEntry.supported_tasks.find((task) => task.id === 'catalogue_expansion_opportunities') || matchedCapability;
      ambiguousCapabilityTasks = null;
    }
  }

  // STRUCTURED CROSS-AGENT CONTEXT PASSING (see agent/core/crossAgentContext.js): now
  // that this step's real capability is known, derive only the fields it actually
  // declares needing from whichever earlier steps in this same plan produced
  // something relevant (the 5 declared specialist-pair flows, plus "All ->
  // Analytics" when this step is analytics_optimization's growth_opportunities
  // capability) - plus tell the matched tool which capability to actually run (see
  // TOOL_CAPABILITY_SELECTORS above). The caller's own explicit researchParams always
  // wins on any field collision - injected context only fills gaps, never overrides
  // real input.
  let effectiveResearchParams = researchParams;
  if (target.type === 'specialist' && matchedCapability && toolMatch) {
    const selectorContext = deriveCapabilitySelectorContext(toolMatch.id, matchedCapability.id);
    const pairContext = deriveCrossAgentContext({
      completedSteps: priorSteps,
      toSpecialistId: target.id,
      toCapabilityId: matchedCapability.id,
      existingResearchParams: researchParams,
    });
    const analyticsContext =
      target.id === 'analytics_optimization' ? deriveAllToAnalyticsContext(priorSteps, matchedCapability.id) : {};
    const liveEvidenceContext = deriveLiveEvidenceContext({
      completedSteps: priorSteps,
      toSpecialistId: target.id,
      toCapabilityId: matchedCapability.id,
      existingResearchParams: researchParams,
    });
    const businessConfigContext = deriveBusinessConfigContext({ toCapabilityId: matchedCapability.id });
    let derivedContext = mergeContext({}, selectorContext);
    derivedContext = mergeContext(derivedContext, pairContext);
    derivedContext = mergeContext(derivedContext, analyticsContext);
    derivedContext = mergeContext(derivedContext, liveEvidenceContext);
    derivedContext = mergeContext(derivedContext, businessConfigContext);
    // MEMORY LAYER CONTEXT (agent/core/memoryContextRetrieval.js): additive only,
    // merged in last, same as every other derive*Context source above - never
    // overrides a real field a tool actually requires, and hasCallerResearchParams
    // (computed above, from the caller's own untouched researchParams) is already
    // decided before this merge happens, so this can never itself trigger the
    // "PREFER REAL DATA OVER NO DATA" live-dispatch swap.
    //
    // TASK-SCOPED WHEN THE TASK IS KNOWN. runOrchestratorContract computes the
    // run-level, business-scoped context before any routing exists, so it cannot know
    // which capability each step will land on. Here it IS known (matchedCapability),
    // which is the only place in the flow where memory can satisfy
    // agent/core/contextBoundaries.js's memory_context boundary in full ("relevant to
    // the current task AND business"). So when this run has a real businessId, the
    // context is re-derived for THIS capability - the same exact-match store read, one
    // extra filter - and the run-level, business-only context is used unchanged
    // otherwise (every caller that passes no businessId, i.e. today's server.js /run,
    // growthWorkflowOrchestrator.js and optimizationCycleOrchestrator.js, behaves
    // exactly as before). getRelevantMemoryContext never throws and returns {} when
    // there is nothing to merge.
    const taskScopedMemoryContext = isValidBusinessId(businessId)
      ? getRelevantMemoryContext(businessId, { capabilityId: matchedCapability.id })
      : relevantMemoryContext || {};
    derivedContext = mergeContext(derivedContext, taskScopedMemoryContext);

    if (Object.keys(derivedContext).length > 0) {
      effectiveResearchParams = { ...derivedContext, ...(researchParams || {}) };
    }
  }

  // LIVE-EVIDENCE SIBLING CAPABILITY. Word overlap picks a capability from the clause's
  // wording alone. For "Review the SEO findings from my Shopify products ..." it picked
  // product_seo (one named product, needs productReference) although no source can name one,
  // while the same specialist's seo_quality_check CAN audit the store's real listings once
  // the Product specialist's live read is in the plan (see runOrchestratorContract's
  // LIVE-EVIDENCE DEPENDENCY, which adds that read). Same principle as PREFER REAL DATA OVER
  // NO DATA above, extended to evidence another step supplies. It switches only when ALL hold:
  //   - the matched capability's required evidence is missing (it would otherwise stop), and
  //     the caller supplied nothing and forced nothing;
  //   - a sibling task declares a live provider (crossAgentContext.js LIVE_EVIDENCE_PROVIDERS)
  //     and its tool is a real candidate for this specialist in the same category;
  //   - this clause is relevant to the provider specialist by the EXISTING routing score, so
  //     an unrelated SEO request ("keyword research for insulated jackets") is never pulled
  //     onto store listings;
  //   - the provider's REAL result is already in this plan and fully satisfies the sibling's
  //     required fields. Nothing is ever assumed or filled in.
  if (
    target.type === 'specialist' &&
    capabilityEntry &&
    matchedCapability &&
    toolMatch &&
    !hasCallerResearchParams &&
    !(forcedSelection && forcedSelection.toolId) &&
    !(matchedCapability.live_data_tool_id && toolMatch.id === matchedCapability.live_data_tool_id) &&
    !topLevelRequiredFieldsSatisfied(matchedCapability.input_contract, effectiveResearchParams)
  ) {
    for (const task of capabilityEntry.supported_tasks) {
      if (task.id === matchedCapability.id) continue;
      const provider = findLiveEvidenceProvider(target.id, task.id);
      if (!provider || !clauseDistinctlyAbout(currentTask, provider.fromSpecialistId, target.id)) continue;
      const siblingToolId = task.tool_ids.find((toolId) => candidateToolIds.includes(toolId));
      const siblingTool = siblingToolId ? getToolById(siblingToolId) : null;
      if (!siblingTool || siblingTool.category !== matchedCategory) continue;
      const siblingContext = deriveLiveEvidenceContext({
        completedSteps: priorSteps,
        toSpecialistId: target.id,
        toCapabilityId: task.id,
        existingResearchParams: researchParams,
      });
      const siblingParams = {
        ...deriveCapabilitySelectorContext(siblingTool.id, task.id),
        ...siblingContext,
        ...(researchParams || {}),
      };
      if (!topLevelRequiredFieldsSatisfied(task.input_contract, siblingParams)) continue;
      appendAuditEvent(runAuditTracker, {
        type: 'agent',
        specialistId: target.id,
        capabilityId: task.id,
        summary:
          `'${matchedCapability.id}' has no source for its required evidence; '${task.id}' does - ` +
          `the '${provider.fromSpecialistId}' live read earlier in this plan - so this step runs '${task.id}'.`,
      });
      toolMatch = siblingTool;
      matchedCapability = task;
      effectiveResearchParams = siblingParams;
      break;
    }
  }

  // SELF-SUFFICIENT LIVE DISPATCH: true when the matched capability's own declared
  // live_data_tool_id (see agent/core/specialistCapabilityRegistry.js) is the tool
  // about to be dispatched - that tool retrieves everything it needs itself (see
  // tools/analyticsDataTool.js, tools/productDataRetrievalTool.js's
  // runProductDataRetrievalTool), so the capability's own input_contract.required list
  // (written for the CALLER-SUPPLIED-evidence path) does not apply here.
  // Also true for the LIVE WEB COMPETITOR RESEARCH swap above: live_competitor_research
  // retrieves everything it needs itself (the objective text - see
  // tools/webCompetitorResearchTool.js), so competitor_research's own
  // input_contract.required (written for the caller-supplied-competitors path) does
  // not apply once that swap has actually happened.
  const isSelfSufficientLiveDispatch =
    Boolean(matchedCapability && matchedCapability.live_data_tool_id && toolMatch && toolMatch.id === matchedCapability.live_data_tool_id) ||
    Boolean(isCompetitorLiveDispatch && toolMatch && toolMatch.id === 'live_competitor_research');

  // STOP AND ASK INSTEAD OF DISPATCHING WITH MISSING EVIDENCE: once effectiveResearchParams
  // reflects everything real that could be gathered (caller input, cross-agent relay from
  // an earlier step, and now live-retrieved evidence), a matched capability whose
  // declared required fields are STILL missing - and which has no self-sufficient live
  // source to fall back on - can only ever produce the tool's own honest 'failed' status
  // if dispatched (see e.g. tools/marketResearchTool.js's "No structured research input
  // was supplied" convention). Stopping here instead is strictly more honest and more
  // useful to the caller: no wasted tool/audit/cache entry, and a response that clearly
  // states what evidence is missing rather than a generic failure - see
  // agent/core/resultSummary.js. Never fabricates a value to get past this check; never
  // dispatches a specialist with a fabricated required field.
  const requiredEvidenceMissing =
    Boolean(matchedCapability) &&
    !isSelfSufficientLiveDispatch &&
    !topLevelRequiredFieldsSatisfied(matchedCapability.input_contract, effectiveResearchParams);

  let executionRequest;
  let outcome;

  if (!toolMatch) {
    executionRequest = {
      objective,
      category: null,
      tool_id: null,
      specialist_id: target.type === 'specialist' ? target.id : null,
      is_shared_infrastructure: target.type === 'shared_infrastructure',
      research_params: effectiveResearchParams,
    };
    outcome = {
      status: 'not_available',
      data: null,
      error: `No tool is registered yet for the '${target.id}' ${target.type === 'specialist' ? 'specialist' : 'capability'}.`,
      classification: null,
    };
  } else if (requiredEvidenceMissing) {
    executionRequest = {
      objective,
      category: matchedCategory,
      tool_id: toolMatch.id,
      specialist_id: target.type === 'specialist' ? target.id : null,
      is_shared_infrastructure: target.type === 'shared_infrastructure',
      research_params: effectiveResearchParams,
    };
    const missingFields = matchedCapability.input_contract.required
      .map((field) => field.split(/[.[]/)[0])
      .filter((field, index, all) => all.indexOf(field) === index)
      .filter((field) => !requiredFieldPresent(field, matchedCapability.input_contract, effectiveResearchParams));
    outcome = {
      status: 'clarification_required',
      data: null,
      error:
        `'${matchedCapability.title}' ${MISSING_EVIDENCE_MARKER} this request did not supply and no ` +
        `approved read-only source can currently retrieve: ${missingFields.join(', ')}. Provide ${missingFields.join(', ')} ` +
        'directly, or ask a specialist step that can produce it first.',
      classification: null,
    };
  } else if (ambiguousCapabilityTasks) {
    // No confident capability match (see bestMatchingTask): a tie, or zero real word
    // overlap, among this target's real candidate tasks. Stop and ask which specific
    // action is intended rather than silently dispatching whichever task happens to be
    // declared first - the same "stop before dispatch" principle as the
    // requiredEvidenceMissing branch above, just for an ambiguous capability instead
    // of a missing field.
    executionRequest = {
      objective,
      category: matchedCategory,
      tool_id: toolMatch.id,
      specialist_id: target.type === 'specialist' ? target.id : null,
      is_shared_infrastructure: target.type === 'shared_infrastructure',
      research_params: effectiveResearchParams,
    };
    const candidateTitles = ambiguousCapabilityTasks.map((task) => task.title).join("', '");
    outcome = {
      status: 'clarification_required',
      data: null,
      error:
        `Could not confidently tell which '${target.id}' action was intended - '${candidateTitles}' matched this ` +
        'request equally (or not at all). Clarify which specific action is intended.',
      classification: null,
    };
  } else {
    executionRequest = createExecutionRequest(
      objective,
      { category: matchedCategory, tool: toolMatch },
      effectiveResearchParams,
      businessId
    );
    outcome = await executeSelectedCapability(
      executionRequest,
      runTokenTracker,
      runApprovalTracker,
      runAuditTracker,
      runToolResultCache,
      runUsageTracker,
      runUsageLedger
    );
  }

  // Only ai_reasoning_completion's structured output carries tokensUsed - every other
  // tool's outcome.data simply doesn't have that field, so this has no effect on them.
  if (outcome && outcome.data && typeof outcome.data.tokensUsed === 'number') {
    runTokenTracker.tokensUsedThisRun += outcome.data.tokensUsed;
  }

  const requiredContextIds = gatherMinimumContext(executionRequest).map((boundary) => boundary.id);
  const verificationStatus = validateResult(outcome);

  return deriveExecutionState({
    request: objective,
    currentTask,
    target,
    category: toolMatch ? matchedCategory : null,
    toolId: toolMatch ? toolMatch.id : null,
    capabilityId: matchedCapability ? matchedCapability.id : null,
    inputContract: matchedCapability ? matchedCapability.input_contract : null,
    requiredContextIds,
    outcome,
    verificationStatus,
    approvalRequestId: outcome ? outcome.approval_request_id || null : null,
  });
}

// Aggregates a plan's per-step completion states (reusing stateModel.js's
// TASK_STATUSES via each step's completion_state) into one overall
// verification/task status: any failed step fails the whole plan; every step must
// complete for the plan to pass; any blocked step blocks the whole plan; anything else
// is honestly in_progress/unverified.
function aggregatePlanState(plan) {
  if (!plan || plan.length === 0) {
    return { verification_status: 'unverified', task_status: 'not_started' };
  }
  if (plan.some((step) => step.completion_state === 'failed')) {
    return { verification_status: 'failed', task_status: 'failed' };
  }
  if (plan.every((step) => step.completion_state === 'complete')) {
    return { verification_status: 'passed', task_status: 'complete' };
  }
  if (plan.some((step) => step.completion_state === 'blocked')) {
    return { verification_status: 'unverified', task_status: 'blocked' };
  }
  return { verification_status: 'unverified', task_status: 'in_progress' };
}

// Shared by any deliberate, explicitly-sequenced caller of buildPlanStep() (e.g.
// agent/core/growthWorkflowOrchestrator.js, agent/core/optimizationCycleOrchestrator.js)
// that needs to build a { type: 'specialist', id, title, text } target directly from
// agent/core/specialistRegistry.js, without going through free-text routing.
function buildSpecialistTarget(specialistId) {
  const specialist = getSpecialistById(specialistId);
  return {
    type: 'specialist',
    id: specialist.id,
    title: specialist.title,
    text: `${specialist.id} ${specialist.title} ${specialist.description}`,
  };
}

// The shared-infrastructure counterpart to buildSpecialistTarget above: the
// buildPlanStep() target for one of toolPermissions.js's
// SHARED_INFRASTRUCTURE_CATEGORIES ('configuration', 'ai_reasoning', 'memory',
// 'verification') - the categories no specialist owns and the orchestrator itself
// reaches directly (specialist_id null). Returns the already-built entry from
// ROUTING_TARGETS rather than composing a second target shape, so a caller can never
// hand buildPlanStep a target the router itself would not produce. Throws on an
// unknown/non-shared category instead of returning a target that would silently fail
// permission checks deeper in the pipeline.
//
// Used by server.js's /ask, which pins the 'ai_reasoning' category so a plain
// conversational question runs through the same checkToolAccess -> TOOL_EXECUTORS
// dispatch, token/usage budget, and audit trail as every other tool call in this
// project, instead of reaching a model client directly.
function buildSharedInfrastructureTarget(category) {
  const target = ROUTING_TARGETS.find(
    (candidate) => candidate.type === 'shared_infrastructure' && candidate.id === category
  );
  if (!target) {
    throw new Error(
      `buildSharedInfrastructureTarget requires a shared-infrastructure category (one of: ${SHARED_INFRASTRUCTURE_CATEGORIES.join(', ')}), got '${category}'.`
    );
  }
  return target;
}

// True when a buildPlanStep()-produced step is paused awaiting a real approval decision
// (see executeSelectedCapability's 'approval_required' path above).
function isGatedForApproval(step) {
  return Array.isArray(step.approvals) && step.approvals.some((approval) => approval.status === 'required');
}

// Rebuilds a step's execution state after resumeApprovedExecution() has produced a real
// resumed outcome, reusing the paused step's own already-derived request/current_task/
// selected_specialist/inputs/required_context (none of those change on resume - only
// the outcome does). Shared by any caller that pauses a buildPlanStep()-produced step
// for approval and needs to fold the resumed outcome back into that same step shape
// once decided.
function reviseStepAfterResume(pausedStep, resumedOutcome) {
  const verificationStatus = validateResult(resumedOutcome);
  return deriveExecutionState({
    request: pausedStep.request,
    currentTask: pausedStep.current_task,
    target: pausedStep.selected_specialist
      ? { type: pausedStep.selected_specialist.type, id: pausedStep.selected_specialist.id, title: pausedStep.selected_specialist.title }
      : null,
    category: pausedStep.inputs ? pausedStep.inputs.category : null,
    toolId: pausedStep.inputs ? pausedStep.inputs.tool_id : null,
    capabilityId: pausedStep.inputs ? pausedStep.inputs.capability_id : null,
    inputContract: pausedStep.inputs ? pausedStep.inputs.input_contract : null,
    requiredContextIds: pausedStep.required_context,
    outcome: resumedOutcome,
    verificationStatus,
    approvalRequestId: null,
  });
}

// Assembles the final structured response around a routing result - state (in-memory
// only, never persisted, see module header) plus every field the caller needs.
// tokensUsedThisRun surfaces agent/core/tokenControls.js's running total so token
// usage is visible in the response, not just enforced silently inside execution.
function buildRoutingResponse({
  objective,
  routing,
  tokensUsedThisRun = 0,
  growthOpportunityDrafts = null,
  pendingApprovals = null,
  auditTrail = null,
  usageLedger = null,
  usageSummary = null,
  researchContinuity = null,
  storeOpportunityPriorities = null,
  seoChangeProposal = null,
  proposalExecution = null,
  proposalCheck = null,
  vendorCorrectionResult = null,
}) {
  const needsMoreInfo = routing.status === 'clarification_required';
  const { verification_status: verificationStatus, task_status: taskStatus } = routing.plan
    ? aggregatePlanState(routing.plan)
    : { verification_status: 'unverified', task_status: 'blocked' };

  const state = createEmptyState(objective || '');
  state.task_status = needsMoreInfo ? 'blocked' : taskStatus;
  state.verification_status = verificationStatus === 'passed' || verificationStatus === 'failed'
    ? verificationStatus
    : 'unverified';
  if (routing.plan) {
    // dedupeArray (reused from crossAgentContext.js, not reimplemented) prevents two
    // steps failing for the identical reason from producing duplicate failed_work
    // entries - "reduce duplicate context" applied to the response's own state.
    const errors = dedupeArray(routing.plan.flatMap((step) => step.errors || []));
    if (errors.length > 0) {
      state.failed_work = errors;
    }
  }

  return {
    objective: objective || null,
    routing,
    needs_more_information: needsMoreInfo,
    verification_status: verificationStatus,
    tokens_used: tokensUsedThisRun,
    state,
    // "Analytics -> Optimization" draft candidates for
    // agent/core/growthOpportunityEngine.js - null (never an empty-by-omission array)
    // when there was no plan to gather them from at all (a clarification-required
    // response); an array (possibly empty) whenever a real plan ran.
    growth_opportunity_drafts: growthOpportunityDrafts,
    // Every approval request created anywhere in this plan (see
    // approvals/approvalWorkflow.js, agent/core/orchestratorExecutionContract.js's
    // executeSelectedCapability) - null (never an empty-by-omission array) when there
    // was no plan to gather them from at all (a clarification-required response); an
    // array (possibly empty) whenever a real plan ran. A human decides these via
    // approvals/approvalWorkflow.js's decideApprovalRequest(), then resumeApprovedExecution()
    // actually executes them - never automatically.
    pending_approvals: pendingApprovals,
    // Every audit/auditTrail.js event recorded anywhere in this run (request, agent,
    // tools, data_access, recommendation, approval, execution, result, error) - null
    // (never an empty-by-omission array) only when understandObjective() itself threw
    // before a tracker could even be created; an array (possibly just the initial
    // 'request'/'error' events) on every other path, including clarification-required
    // responses, so a partial trail is never silently dropped.
    audit_trail: auditTrail,
    // Every usage/usageTracker.js event recorded anywhere in this run (model_call,
    // tool_call, api_call, research_op, agent_task) - null only when
    // understandObjective() itself threw before a ledger could even be created; an
    // array (possibly just the initial agent_task events) on every other path,
    // including clarification-required responses, mirroring audit_trail's own
    // never-silently-dropped convention. Shaped for a future SaaS pricing/metering
    // engine to consume - this module does no pricing itself.
    usage_ledger: usageLedger,
    usage_summary: usageSummary,
    // Present only on a run that continued completed research: where its evidence came from
    // (agent/core/researchContext.js), and the ranked opportunities built from it.
    ...(researchContinuity ? { research_continuity: researchContinuity } : {}),
    ...(storeOpportunityPriorities ? { store_opportunity_priorities: storeOpportunityPriorities } : {}),
    // Present only when the continued objective asked for changes to be proposed for approval.
    ...(seoChangeProposal ? { seo_change_proposal: seoChangeProposal } : {}),
    // Present only when the objective asked to apply an existing proposal (agent/core/proposalExecution.js).
    ...(proposalExecution ? { proposal_execution: proposalExecution } : {}),
    // Present only when the objective asked to check an existing proposal against the store, read-only.
    ...(proposalCheck ? { proposal_check: proposalCheck } : {}),
    // Present only when the objective proposed or asked about a vendor correction (agent/core/vendorCorrectionRequest.js).
    ...(vendorCorrectionResult ? { vendor_correction: vendorCorrectionResult } : {}),
  };
}

// Pulls the first top-level JSON array out of `text` and parses it, tolerating the
// prose/code-fence wrapping a model reply commonly adds around the JSON it was asked
// for (e.g. "Here you go:\n```json\n[...]\n```"). Returns null (never throws) for
// anything that isn't parseable as an array - the caller treats that exactly like an
// AI failure, falling back to the deterministic result.
function extractJsonArray(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    return null;
  }
}

// AI-ASSISTED RE-SEGMENTATION FALLBACK - see this function's call site in
// runOrchestratorContract below for why it exists and the guarantees around when it is
// (and is not) trusted. Deliberately narrow: this asks Claude (via
// tools/aiReasoningCompletion.js's runReasoningCompletion() - the same sanctioned,
// budget-checked, already-tested path every other AI-backed capability in this file
// dispatches through; never a second/ad-hoc AI client) to do ONLY phrase segmentation,
// never capability selection - it is never told what capabilities/specialists exist, so
// it cannot invent one, and every string it returns is re-validated through the exact
// same deterministic routeClause() every other clause in this file goes through before
// ever being trusted. Returns null (never throws) on any failure - a missing/invalid
// API key, a network error, an unparseable or empty reply, or even one proposed clause
// that does not cleanly match a real capability - so the caller can always safely fall
// back to the original clarification_required result.
async function attemptAiAssistedSegmentation(objective) {
  let completion;
  try {
    completion = await aiReasoningCompletion.runReasoningCompletion({
      instruction:
        'You split a short task instruction into its independent, self-contained ' +
        'parts. Rules: only split when the text genuinely contains more than one ' +
        'separate instruction; never merge, omit, or add an instruction - only decide ' +
        'where one ends and another begins, keeping each part\'s original wording as ' +
        'close as possible (connector words like "and"/"also"/"then" between parts may ' +
        'be dropped, but every other word must be preserved); if it is really just ONE ' +
        'instruction, return an array containing that single instruction unchanged. ' +
        'Respond with ONLY a JSON array of strings - no prose, no code fences, nothing ' +
        `else.\n\nText: ${JSON.stringify(objective)}`,
      maxTokens: 400,
    });
  } catch (err) {
    return null;
  }

  const candidateClauses = extractJsonArray(completion.text);
  if (!candidateClauses) return null;

  const trimmedClauses = candidateClauses
    .filter((clause) => typeof clause === 'string' && clause.trim().length > 0)
    .map((clause) => clause.trim());
  if (trimmedClauses.length === 0) return null;

  // Re-route every AI-proposed clause through planRouting()'s own deterministic
  // matcher (reused directly, never reimplemented) - accepted only if EVERY clause
  // cleanly matches exactly one capability; a single remaining unmatched/ambiguous
  // clause abandons the whole attempt rather than returning a partial/guessed plan.
  const orderedEntries = [];
  const seen = new Set();
  for (const clause of trimmedClauses) {
    // Each proposed clause must plan on its own through planRouting - objective interpretation
    // included - so a re-segmentation can never turn an unsupported action into a routed one.
    const clausePlan = planRouting(clause);
    if (clausePlan.status !== 'planned') return null;

    clausePlan.targets.forEach((target, index) => {
      const key = `${target.type}:${target.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        orderedEntries.push({ target, segment: clausePlan.segments[index] });
      }
    });
  }

  orderedEntries.sort((a, b) => ROUTING_TARGETS.indexOf(a.target) - ROUTING_TARGETS.indexOf(b.target));

  return {
    status: 'planned',
    targets: orderedEntries.map((entry) => entry.target),
    segments: orderedEntries.map((entry) => entry.segment),
  };
}

// The single entry point: normalizes the task, routes it into a controlled execution
// plan (or a clarification requirement), executes every planned step, and returns the
// final structured response. Never throws - all failures become structured outcomes.
//
// researchParams (optional, in the second argument) is a structured passthrough for
// research tools (see TOOL_EXECUTORS/createExecutionRequest above) - routing itself is
// still decided purely by the existing free-text word-overlap logic; researchParams
// only affects what a matched research tool is actually called with. Omitted by every
// existing caller, so default behavior (and every existing test) is unchanged.
//
// researchContext (optional) is what a Command Center session knows about completed research for
// its business's connected store (agent/core/researchContext.js's lookupResearchContext). Only a
// session passes it; with it omitted, this function behaves exactly as before.
async function runOrchestratorContract(rawTask, { researchParams = null, businessId = null, researchContext = null } = {}) {
  // One audit tracker per run - see audit/auditTrail.js. Created before anything else
  // so even a validation failure on the very first line is itself a recorded event;
  // never module-level state, same caller-held-per-run pattern as runTokenTracker/
  // runApprovalTracker below.
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const runAuditTracker = createAuditTracker(runId, businessId);
  // One usage ledger per run - see usage/usageTracker.js. Created at the same point
  // as runAuditTracker (not the later-created runUsageTracker limiter below) so it
  // appears on every response path, including the early clarification-required
  // returns, exactly like audit_trail already does.
  const runUsageLedger = createUsageLedger(runId, businessId);

  let objective;
  try {
    objective = understandObjective(rawTask);
    appendAuditEvent(runAuditTracker, {
      type: 'request',
      summary: `Objective received: ${objective}`,
    });
  } catch (err) {
    appendAuditEvent(runAuditTracker, {
      type: 'error',
      status: 'error',
      summary: err.message,
    });
    return buildRoutingResponse({
      objective: typeof rawTask === 'string' ? rawTask : null,
      routing: {
        status: 'clarification_required',
        clarification_type: 'unmatched',
        reason: err.message,
        candidates: null,
        unmatched_segment: null,
        plan: null,
      },
      auditTrail: runAuditTracker.events,
      usageLedger: runUsageLedger.events,
      usageSummary: summarizeUsage(runUsageLedger),
    });
  }

  let routingResult = planRouting(objective);

  // PROPOSAL EXECUTION (agent/core/proposalExecution.js). Decided on the objective's structure BEFORE
  // clarification: "Apply the proposed SEO title ... from the pending approval" is not an unsupported
  // action when its object is a proposal the approval system already holds. It is resolved against
  // durable approval state and answered with one gated approval - or a precise question back, with no
  // approval - and never continues into research or routing.
  // VENDOR CORRECTIONS (agent/core/vendorCorrectionRequest.js). Decided BEFORE the SEO proposal decisions below,
  // which only know SEO proposals: a request to propose a vendor change is resolved against the live store and
  // becomes one gated approval, and a question about an existing vendor correction is answered from the stored
  // vendor corrections - never from SEO proposals.
  const vendorDecision = vendorCorrection.decideVendorCorrection({ objective, routingResult });
  if (vendorDecision.kind) {
    return runVendorCorrection({ objective, decision: vendorDecision, businessId, runId, runAuditTracker, runUsageLedger });
  }

  const proposalDecision = decideProposalExecution({ objective, routingResult });
  if (proposalDecision.applies) {
    return runProposalExecution({ objective, decision: proposalDecision, businessId, researchContext, runId, runAuditTracker, runUsageLedger });
  }
  // A READ-ONLY CHECK of an existing proposal against the store ("compare the current values with the
  // existing approved SEO proposal ... do not create or execute any approval") is answered directly: one
  // gated read, a value-by-value comparison, and the execution checks evaluated without creating anything.
  if (decideProposalCheck({ objective, routingResult }).applies) {
    return runProposalCheck({ objective, businessId, researchContext, runId, runAuditTracker, runUsageLedger });
  }

  // RESEARCH CONTINUITY (agent/core/researchContext.js's decideResearchContinuity). Decided on the
  // objective and its interpretation BEFORE clarification or AI re-segmentation: an objective that
  // builds on completed research ("Using the real Shopify data you just analysed, rank ...") is
  // answered from that research's basis, so it neither dead-ends nor re-routes to an unrelated
  // reader. It never applies to a change, an unsupported action or platform, or another platform's
  // data, and every step it adds still goes through buildPlanStep's gates.
  const continuity = decideResearchContinuity({ objective, routingResult, researchContext });
  if (continuity.applies && routingResult.status !== 'planned') {
    // The clarification came only from clauses that refer to the research itself. Every clause the
    // router DID resolve to a target is kept, in routing order, so the objective's own tasks are
    // not dropped along with the reference.
    const resolved = [];
    for (const entry of routingResult.interpretation || []) {
      if (!entry || entry.disposition !== 'task' || !entry.target || resolved.some((item) => item.target.id === entry.target)) continue;
      const target = ROUTING_TARGETS.find((candidate) => candidate.id === entry.target);
      if (target) resolved.push({ target, segment: entry.clause });
    }
    resolved.sort((a, b) => ROUTING_TARGETS.indexOf(a.target) - ROUTING_TARGETS.indexOf(b.target));
    routingResult = {
      status: 'planned',
      targets: resolved.map((item) => item.target),
      segments: resolved.map((item) => item.segment),
      interpretation: routingResult.interpretation || [],
    };
  }

  // AI-ASSISTED RE-SEGMENTATION FALLBACK (real-world regression, reported live by the
  // store owner - see attemptClauseRecovery()'s own header above for the free,
  // deterministic first line of defense and exactly why it cannot be complete on its
  // own). Only ever attempted for clarification_type 'unmatched' - never 'ambiguous'
  // (a genuine two-target tie, not a segmentation problem) - and only ever ACCEPTED if
  // every clause it proposes then matches a real capability via the same deterministic
  // routeClause() every other clause in this file goes through, so this can only ever
  // turn a would-be clarification into a correctly-routed plan, never invent or guess
  // one; a failed/unreachable/unparseable attempt silently falls back to the original,
  // honest clarification_required result below - never worse than before this fallback
  // existed.
  //
  // NO MODEL CALL FOR TEXT THE SYSTEM CANNOT RECOGNISE AT ALL: re-segmentation only helps when the unmatched part
  // names something this system does (a known system word). Gibberish, or an instruction about something no
  // capability covers, asks for clarification without spending a call.
  if (
    routingResult.status === 'clarification_required' &&
    routingResult.clarification_type === 'unmatched' &&
    !routingResult.interpretation_blocked &&
    tokenize(routingResult.unmatched_segment || objective).some(isSystemWord)
  ) {
    const recovered = await attemptAiAssistedSegmentation(objective);
    if (recovered) {
      appendAuditEvent(runAuditTracker, {
        // 'agent' - not a new event type - is the same category buildPlanStep() below
        // already uses for a specialist-selection decision (see its own
        // appendAuditEvent call); this is that same kind of routing decision, just
        // reached via the AI-segmentation fallback instead of the direct deterministic
        // path, so it belongs in the same category rather than inventing a new one
        // audit/auditRecordModel.js's fixed AUDIT_EVENT_TYPES enum does not list.
        type: 'agent',
        summary: `AI-assisted segmentation recovered a plan after the deterministic router reported "${routingResult.reason}"`,
      });
      routingResult = recovered;
    }
  }

  if (routingResult.status === 'clarification_required') {
    return buildRoutingResponse({
      objective,
      routing: { ...routingResult, plan: null },
      auditTrail: runAuditTracker.events,
      usageLedger: runUsageLedger.events,
      usageSummary: summarizeUsage(runUsageLedger),
    });
  }

  // BOUNDED AGENT ITERATIONS (agent/core/executionBounds.js): checked before any
  // step executes - a plan that routed to too many targets fails fast and honestly,
  // exactly like the unmatched/ambiguous clarification cases above, rather than
  // silently executing only the first N steps and dropping the rest.
  const planStepBounds = checkPlanStepBounds(
    routingResult.targets.length + (continuity.applies ? STORE_RESEARCH_BASIS.length : 0)
  );
  if (!planStepBounds.allowed) {
    appendAuditEvent(runAuditTracker, {
      type: 'error',
      status: 'error',
      summary: planStepBounds.reason,
    });
    return buildRoutingResponse({
      objective,
      routing: {
        status: 'clarification_required',
        clarification_type: 'plan_too_large',
        reason: planStepBounds.reason,
        candidates: null,
        unmatched_segment: null,
        plan: null,
      },
      auditTrail: runAuditTracker.events,
      usageLedger: runUsageLedger.events,
      usageSummary: summarizeUsage(runUsageLedger),
    });
  }

  // One tracker per run, threaded through every plan step - see buildPlanStep and
  // executeSelectedCapability above. This is what lets agent/core/tokenControls.js
  // enforce a budget across the whole run, not just per call.
  const runTokenTracker = { tokensUsedThisRun: 0 };
  // One approval-request tracker per run, same pattern as runTokenTracker above - a
  // plain mutable accumulator the caller holds, never module-level state (see
  // approvals/approvalWorkflow.js's own header on why this project never holds hidden
  // state). Every approval_required outcome anywhere in this plan appends to it.
  // id_prefix makes this run's approval ids unique across runs - see approvalIdFor above.
  // Reuses runId, which this run already created for its audit trail and usage ledger, so
  // an approval, its audit events and its usage events all name the same run.
  const runApprovalTracker = { requests: [], id_prefix: runId };
  // One tool-result cache per run, same caller-held-state pattern as the trackers
  // above (see agent/core/toolResultCache.js) - an identical tool call anywhere later
  // in this same plan reuses its first result instead of re-executing and
  // re-embedding it ("reduce repeated tool results", "reduce repeated business
  // information").
  const runToolResultCache = createToolResultCache();
  // One usage tracker per run, same caller-held-state pattern as the trackers above
  // (see agent/core/usageLimits.js) - counts real (cache-miss) tool/model/research/
  // external-API dispatches so this run's configurable ceilings can be enforced.
  const runUsageTracker = createUsageTracker();

  // MEMORY LAYER - RETRIEVAL (agent/core/memoryContextRetrieval.js): fetched ONCE,
  // before any step executes ("before a run" - never re-fetched per step), and
  // threaded into every buildPlanStep call below via the same additive-context
  // mechanism deriveBusinessConfigContext/deriveCrossAgentContext already use. A
  // null/invalid businessId (today's default single-business server.js behavior) is a
  // documented no-op - see getRelevantMemoryContext's own header - so this line has no
  // effect at all for any existing caller that doesn't pass a real businessId.
  const relevantMemoryContext = getRelevantMemoryContext(businessId);
  if (isValidBusinessId(businessId)) {
    const memoryCount = relevantMemoryContext.relevant_memory ? relevantMemoryContext.relevant_memory.length : 0;
    appendAuditEvent(runAuditTracker, {
      type: 'data_access',
      summary:
        memoryCount > 0
          ? `Retrieved ${memoryCount} relevant memory record(s) for business '${businessId}'.`
          : `No saved memory records found yet for business '${businessId}'.`,
    });
  }

  // MEMORY LAYER - PERSISTENCE (agent/core/memoryContextRetrieval.js): after a specialist (never
  // shared-infrastructure) step completes with verification_status 'passed'
  // (step.completion_state === 'complete' - see deriveExecutionState), save a compact record of it
  // as a reusable finding. Reuses summarizeExecutionState's own compact, honest sentence unchanged
  // as the record's summary - never a second summarization path. A null/invalid businessId is a
  // documented no-op (see persistVerifiedFinding's own header), so this has no effect for any
  // existing caller. Reused research is never saved again - it was saved when it was produced.
  const persistFinding = (step, stepKey) => {
    if (!isValidBusinessId(businessId) || !step.selected_specialist || step.selected_specialist.type !== 'specialist' || step.completion_state !== 'complete') return;
    const toolId = step.inputs ? step.inputs.tool_id : null;
    const capabilityId = step.inputs ? step.inputs.capability_id : null;
    const savedRecord = persistVerifiedFinding({
      businessId,
      id: `mem-${runId}-${stepKey}`,
      priorityId: 'reusable_findings',
      summary: summarizeExecutionState(step),
      source: { run_id: runId, tool_id: toolId, capability_id: capabilityId },
      verificationStatus: 'passed',
    });
    appendAuditEvent(runAuditTracker, {
      type: 'result',
      specialistId: step.selected_specialist.id,
      toolId,
      status: savedRecord ? 'saved' : 'not_saved',
      summary: savedRecord
        ? `Saved a reusable finding to memory for business '${businessId}'.`
        : `Could not save this finding to memory for business '${businessId}'.`,
    });
  };

  const plan = [];
  let providerStepsAdded = 0;

  // RESEARCH CONTINUITY - THE BASIS. Reused: the completed research's own steps, copied unchanged
  // and marked with where and when they were produced; no tool runs and nothing is read again.
  // Fresh (no completed, fresh, authoritative research for this store): the basis capabilities run
  // now, read-only, through buildPlanStep - permissions, the mutation-intent gate, budgets, usage
  // and audit apply exactly as for any routed step.
  let researchContinuity = null;
  const continuationCovered = new Set();
  if (continuity.applies) {
    const considered = continuity.considered || {};
    const platformName = continuity.platform.charAt(0).toUpperCase() + continuity.platform.slice(1);
    if (continuity.research) {
      const source = continuity.research;
      for (const priorStep of source.steps) {
        const step = JSON.parse(JSON.stringify(priorStep));
        step.reused_research = { run_id: source.run_id, produced_at: source.produced_at };
        plan.push(step);
        const specialistId =
          step.selected_specialist && step.selected_specialist.type === 'specialist' ? step.selected_specialist.id : null;
        if (specialistId) continuationCovered.add(specialistId);
        appendAuditEvent(runAuditTracker, {
          type: 'data_access',
          specialistId,
          toolId: step.inputs ? step.inputs.tool_id : null,
          capabilityId: step.inputs ? step.inputs.capability_id : null,
          status: 'reused',
          summary: `Reused completed research from run ${source.run_id} (produced ${source.produced_at}) instead of reading the store again.`,
        });
      }
      const provenance = source.provenance || {};
      researchContinuity = {
        mode: 'reused',
        platform: continuity.platform,
        freshness_limit_hours: continuity.freshness_limit_hours,
        source: {
          run_id: source.run_id,
          session_id: source.session_id || null,
          produced_at: source.produced_at,
          age_minutes: Math.floor((Number(source.age_ms) || 0) / 60000),
          specialists: (provenance.specialists || []).map((entry) => entry.title || entry.id),
          outcome: provenance.outcome || null,
          real_store_data: provenance.real_store_data === true,
        },
        considered,
        reason: `Continued completed ${platformName} research from run ${source.run_id}.`,
      };
    } else {
      for (const [index, basis] of STORE_RESEARCH_BASIS.entries()) {
        const step = await buildPlanStep(
          buildSpecialistTarget(basis.specialistId),
          objective,
          objective,
          runTokenTracker,
          researchParams,
          plan,
          runApprovalTracker,
          runAuditTracker,
          runToolResultCache,
          runUsageTracker,
          businessId,
          runUsageLedger,
          { toolId: basis.toolId, capabilityId: basis.capabilityId },
          relevantMemoryContext
        );
        plan.push(step);
        continuationCovered.add(basis.specialistId);
        persistFinding(step, `basis-${index}`);
      }
      const passedOver = [];
      if (considered.stale > 0) passedOver.push(`the newest was produced ${considered.newest_stale_produced_at} and is past the freshness limit`);
      if (considered.not_authoritative > 0) passedOver.push(`${considered.not_authoritative} partial or failed run(s) were not treated as completed research`);
      if (considered.incomplete > 0) passedOver.push(`${considered.incomplete} run(s) did not cover products, SEO/listing quality and sales`);
      researchContinuity = {
        mode: 'fresh',
        platform: continuity.platform,
        freshness_limit_hours: continuity.freshness_limit_hours,
        source: null,
        considered,
        reason:
          `No completed ${platformName} research for this store from the last ${continuity.freshness_limit_hours} hour(s) was available` +
          (passedOver.length > 0 ? ` (${passedOver.join('; ')})` : '') +
          ', so fresh read-only research was run first.',
      };
    }
  }

  for (let i = 0; i < routingResult.targets.length; i += 1) {
    // In a continuation, a routed target adds a step only when it is asked to PRODUCE something the
    // research basis cannot answer (researchContext.js's routedTargetNeedsOwnStep). A specialist the
    // basis already covers, or one routed from a clause that reads, ranks or refers to the research,
    // adds none - otherwise "Review the research you already have" would ask Research for trends
    // and "Rank the top opportunities" would start a fresh Product catalogue search.
    const routedTarget = routingResult.targets[i];
    const basisCovers = continuationCovered.has(routedTarget.id);
    // Shared infrastructure (compliance, approvals, memory, ...) is applied BY the Chief to the
    // continuation itself - "prepare the changes for my approval" is the approval gate below, not a
    // separate compliance step with no content to check.
    const sharedInfrastructure = routedTarget.type !== 'specialist';
    if (continuity.applies && (basisCovers || sharedInfrastructure || !routedTargetNeedsOwnStep(routingResult.interpretation, routedTarget.id))) {
      appendAuditEvent(runAuditTracker, {
        type: 'agent',
        ...(sharedInfrastructure ? {} : { specialistId: routedTarget.id }),
        summary: basisCovers
          ? `'${routedTarget.id}' is answered by the research basis already in this plan, so no second step was added.`
          : sharedInfrastructure
            ? `'${routedTarget.id}' is shared infrastructure the Chief applies to this continuation itself, so no separate step was added.`
            : `'${routedTarget.id}' was routed from a clause that reads, ranks or refers to the research, not one asking it to produce new output; the research basis and its ranking answer it, so no '${routedTarget.id}' step was added.`,
      });
      continue;
    }
    // plan already holds every step completed so far (0..i-1) at this point - passed
    // as priorSteps so buildPlanStep can derive structured cross-agent context for
    // this step from them (see agent/core/crossAgentContext.js).
    const buildRoutedStep = () =>
      buildPlanStep(
        routingResult.targets[i],
        objective,
        routingResult.segments[i],
        runTokenTracker,
        researchParams,
        plan,
        runApprovalTracker,
        runAuditTracker,
        runToolResultCache,
        runUsageTracker,
        businessId,
        runUsageLedger,
        // The capability this target's own clauses named, when they named one (see planRouting's
        // `capabilities`). null for every objective that named none, which is the existing
        // word-overlap path unchanged.
        (routingResult.capabilities || [])[i] || null,
        relevantMemoryContext
      );
    let step = await buildRoutedStep();

    // LIVE-EVIDENCE DEPENDENCY. Routing decides WHICH specialists a request is about; it
    // cannot know that one capability's required evidence only exists after another
    // specialist's live read ("Review the SEO findings from my Shopify products" routes to
    // SEO alone, but seo_quality_check audits listings that only the Product read supplies).
    // So when a step stopped BEFORE dispatch for missing evidence, the capability declares a
    // live provider (crossAgentContext.js's LIVE_EVIDENCE_PROVIDERS), and no step in this plan
    // has already supplied it, the provider's own read-only live capability runs first -
    // through buildPlanStep, so permissions, the mutation-intent gate, budgets, usage and
    // audit apply exactly as for any step - and the stopped step is built again from the real
    // result. It never fabricates: if the read fails or returns nothing, the retried step
    // stops for the same honest reason. The run's plan-size ceiling still applies.
    // The provider is the stopped capability's own declared one, or - when word overlap chose
    // a sibling capability that has no source at all - one declared for another capability of
    // the SAME specialist, provided this clause is relevant to the provider specialist by the
    // existing routing score (buildPlanStep then switches to that sibling only if the real
    // result satisfies it; see its LIVE-EVIDENCE SIBLING CAPABILITY block).
    let provider = null;
    if (step.selected_specialist && step.selected_specialist.type === 'specialist' && step.inputs) {
      const specialistId = step.selected_specialist.id;
      provider = findLiveEvidenceProvider(specialistId, step.inputs.capability_id);
      if (!provider) {
        const capabilityEntry = getSpecialistCapabilityById(specialistId);
        for (const task of (capabilityEntry && capabilityEntry.supported_tasks) || []) {
          const candidate = findLiveEvidenceProvider(specialistId, task.id);
          if (candidate && clauseDistinctlyAbout(routingResult.segments[i], candidate.fromSpecialistId, specialistId)) {
            provider = candidate;
            break;
          }
        }
      }
    }
    if (provider && stoppedForMissingEvidence(step) && !planHasProviderResult(plan, provider)) {
      const bounds = checkPlanStepBounds(routingResult.targets.length + providerStepsAdded + 1);
      if (bounds.allowed) {
        appendAuditEvent(runAuditTracker, {
          type: 'agent',
          specialistId: provider.fromSpecialistId,
          capabilityId: provider.fromCapabilityId,
          summary:
            `'${step.selected_specialist.id}' step '${step.inputs.capability_id}' stopped for missing evidence; ` +
            `'${provider.toCapabilityId}' can use the '${provider.fromSpecialistId}' specialist's live read ` +
            `(${provider.fromToolId}) - adding that read-only step first.`,
        });
        const providerStep = await buildPlanStep(
          buildSpecialistTarget(provider.fromSpecialistId),
          objective,
          routingResult.segments[i],
          runTokenTracker,
          researchParams,
          plan,
          runApprovalTracker,
          runAuditTracker,
          runToolResultCache,
          runUsageTracker,
          businessId,
          runUsageLedger,
          { toolId: provider.fromToolId, capabilityId: provider.fromCapabilityId },
          relevantMemoryContext
        );
        plan.push(providerStep);
        providerStepsAdded += 1;
        step = await buildRoutedStep();
      }
    }
    plan.push(step);

    // MEMORY LAYER - PERSISTENCE (agent/core/memoryContextRetrieval.js): after a
    // specialist (never shared-infrastructure) step completes with
    // verification_status 'passed' (step.completion_state === 'complete' - see
    // deriveExecutionState), save a compact record of it as a reusable finding.
    // Reuses summarizeExecutionState's own already-established, compact, honest
    // sentence unchanged as the record's summary - never a second summarization path.
    // A null/invalid businessId is a documented no-op (see persistVerifiedFinding's
    // own header), so this has no effect for any existing caller.
    persistFinding(step, i);
  }

  // "Analytics -> Optimization": every growth-opportunity-shaped record produced
  // anywhere in this plan, gathered into draft candidates for the standalone
  // agent/core/growthOpportunityEngine.js - see gatherGrowthOpportunityDrafts's own
  // header for why this never calls rankGrowthOpportunities() automatically.
  const growthOpportunityDrafts = gatherGrowthOpportunityDrafts(plan);

  // The ranked answer a continued objective asked for - built only from the basis steps' real
  // results (agent/core/storeOpportunityPrioritization.js). null for every other run.
  const storeOpportunityPriorities = continuity.applies ? prioritizeStoreOpportunities({ steps: plan }) : null;

  // CHANGE PROPOSAL (agent/core/seoChangeProposal.js). When the continued objective asks for changes
  // to be PROPOSED rather than made, the before/after values are built from the basis evidence, run
  // through compliance, and each eligible product gets one approval_required request through the
  // existing approval workflow - the same tracker, id scheme and audit events every gated step uses,
  // persisted by the caller exactly like any other pending approval. Nothing here executes, and the
  // proposal's approval tool is a read: no approval created here can write to the store.
  let seoChangeProposal = null;
  if (continuity.applies && continuity.intent === 'change_proposal') {
    seoChangeProposal = proposeSeoChanges({
      steps: plan,
      priorities: storeOpportunityPriorities,
      objective,
      businessId,
      storeReference: researchContext && typeof researchContext.store_reference === 'string' ? researchContext.store_reference : null,
      sourceRunId: researchContinuity && researchContinuity.source ? researchContinuity.source.run_id : null,
    });
    for (const product of seoChangeProposal.products) {
      if (!product.approval_eligible) {
        appendAuditEvent(runAuditTracker, {
          type: 'approval',
          toolId: PROPOSAL_TOOL_ID,
          specialistId: PROPOSAL_SPECIALIST_ID,
          status: 'not_requested',
          summary: `No approval was requested for the SEO proposal on '${product.product_reference}': compliance returned ${product.compliance.compliance_status}.`,
        });
        continue;
      }
      const approvalRequest = createApprovalRequest({
        id: approvalIdFor(runApprovalTracker),
        classification: 'approval_required',
        specialistId: PROPOSAL_SPECIALIST_ID,
        toolId: PROPOSAL_TOOL_ID,
        executionRequest: product.execution_request,
        reason: product.approval_reason,
      });
      runApprovalTracker.requests.push(approvalRequest);
      product.approval_id = approvalRequest.id;
      appendAuditEvent(runAuditTracker, {
        type: 'approval',
        toolId: PROPOSAL_TOOL_ID,
        specialistId: PROPOSAL_SPECIALIST_ID,
        classification: 'approval_required',
        status: 'pending',
        summary: `Approval request '${approvalRequest.id}' created for proposed SEO changes on '${product.product_reference}'. Nothing was written to the store.`,
      });
    }
  }

  return buildRoutingResponse({
    researchContinuity,
    storeOpportunityPriorities,
    seoChangeProposal,
    objective,
    routing: {
      status: 'planned',
      clarification_type: null,
      reason: null,
      candidates: null,
      unmatched_segment: null,
      plan,
    },
    tokensUsedThisRun: runTokenTracker.tokensUsedThisRun,
    growthOpportunityDrafts,
    pendingApprovals: runApprovalTracker.requests,
    auditTrail: runAuditTracker.events,
    usageLedger: runUsageLedger.events,
    usageSummary: summarizeUsage(runUsageLedger),
  });
}

// Answers a READ-ONLY check of an existing SEO proposal against the store (proposalExecution.js's
// decideProposalCheck).
//
// The proposal is resolved exactly as an apply request would resolve it. The store is then read ONCE,
// through the same gated Product read the research basis uses (buildPlanStep: permissions, platform
// gate, usage and audit), and each proposed field's CURRENT value is compared directly with the
// proposal's before and after values. Every condition an execution would have to meet is evaluated on
// the request an execution WOULD create - the stored-proposal match, the before-values, whether it was
// already applied, the compliance verdict of the values that would be written, permission and platform -
// without creating, approving or executing anything. No compliance step runs on empty content: there is
// no content to check until there is a change to write, and that change's own values are what is checked.
async function runProposalCheck({ objective, businessId, researchContext, runId, runAuditTracker, runUsageLedger }) {
  const respond = (routing, extra = {}) =>
    buildRoutingResponse({
      objective,
      routing,
      auditTrail: runAuditTracker.events,
      usageLedger: runUsageLedger.events,
      usageSummary: summarizeUsage(runUsageLedger),
      ...extra,
    });
  const noWrite = { store_writes: 0, approvals_created: 0 };

  const resolution = resolveProposalExecution({
    objective,
    businessId,
    storeReference: researchContext && typeof researchContext.store_reference === 'string' ? researchContext.store_reference : undefined,
  });
  appendAuditEvent(runAuditTracker, {
    type: 'data_access',
    status: resolution.status,
    summary:
      resolution.status === 'resolved'
        ? `Read-only proposal check: resolved to stored SEO proposal '${resolution.source.approval_id}' for '${resolution.source.product_reference}'.`
        : `Read-only proposal check: looked up stored SEO proposals (${resolution.considered.proposals} for this business): ${resolution.status}.`,
  });
  if (resolution.status !== 'resolved') {
    return respond(
      {
        status: 'clarification_required',
        clarification_type: resolution.status === 'ambiguous' ? 'proposal_ambiguous' : 'proposal_not_resolved',
        reason: resolution.reason,
        candidates: null,
        unmatched_segment: null,
        plan: null,
      },
      { proposalCheck: { status: 'not_checked', reason: resolution.reason, candidates: resolution.candidates, ...noWrite } }
    );
  }

  // ONE live read, through the gated Product read.
  const basis = STORE_RESEARCH_BASIS[0];
  const runApprovalTracker = { requests: [], id_prefix: runId };
  const readStep = await buildPlanStep(
    buildSpecialistTarget(basis.specialistId),
    objective,
    objective,
    { tokensUsedThisRun: 0 },
    null,
    [],
    runApprovalTracker,
    runAuditTracker,
    createToolResultCache(),
    createUsageTracker(),
    businessId,
    runUsageLedger,
    { toolId: basis.toolId, capabilityId: basis.capabilityId },
    null
  );
  const productId = resolution.research_params.productId;
  const sources = readStep.completion_state === 'complete' && readStep.outputs && Array.isArray(readStep.outputs.listing_sources)
    ? readStep.outputs.listing_sources
    : null;
  const current = sources ? sources.find((source) => source && source.shopify_product_id === productId) || null : null;
  const comparable = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const fields = resolution.applied_changes.map((change) => {
    const key = change.shopify_field === 'seo.title' ? 'seo_title' : 'seo_description';
    const readable = Boolean(current) && !(Array.isArray(current.unavailable_fields) && current.unavailable_fields.includes(key));
    const value = readable ? current[key] : null;
    return {
      shopify_field: change.shopify_field,
      before: change.before,
      after: change.after,
      current: value,
      matches_before: readable ? comparable(value) === comparable(change.before) : null,
      matches_after: readable ? value === change.after : null,
    };
  });
  const readFailure = !sources
    ? 'The store could not be read, so the current values are unknown.'
    : !current
      ? `Product '${productId}' was not found in the store read.`
      : fields.some((field) => field.current === null)
        ? 'The store read did not return every proposed SEO field.'
        : null;
  const allMatchBefore = !readFailure && fields.every((field) => field.matches_before);

  // What an execution would have to pass - evaluated on the request it WOULD create, creating nothing.
  const tool = getToolById(PROPOSAL_APPLICATION_TOOL_ID);
  const wouldExecute = createExecutionRequest(objective, { category: tool.category, tool }, resolution.research_params, businessId);
  const checks = [];
  const check = (id, passed, detail) => checks.push({ check: id, passed: Boolean(passed), detail });
  check('proposal_applicable', true, `Stored SEO proposal ${resolution.source.approval_id} is '${resolution.source.approval_status}' and was made for the connected store.`);
  const source = verifyCorrectionSource(tool.id, wouldExecute);
  check('matches_stored_proposal', source.ok, source.ok ? 'The values to apply are exactly the stored proposal\'s.' : source.reason);
  check(
    'store_values_match_before',
    allMatchBefore,
    readFailure || (allMatchBefore ? 'Every current store value still equals the proposal\'s before-value.' : 'At least one current store value differs from the proposal\'s before-value, so applying it would be refused.')
  );
  const already = checkCorrectionAlreadyVerified(tool.id, wouldExecute);
  check('not_already_applied', already.allowed, already.allowed ? 'This change has not been applied and verified before.' : 'This exact change has already been applied and verified.');
  let complianceStatus = null;
  try {
    const input = buildCorrectionComplianceInput(tool.id, wouldExecute);
    complianceStatus = input ? evaluateCompliance(input).status : null;
  } catch (err) {
    complianceStatus = null;
  }
  check(
    'compliance_not_block',
    complianceStatus !== null && complianceStatus !== 'BLOCK',
    complianceStatus === null ? 'Compliance could not be evaluated for the values that would be written.' : `Compliance for the values that would be written: ${complianceStatus}.`
  );
  const access = checkToolAccess({ specialistId: wouldExecute.specialist_id, toolId: tool.id, enabledPlatforms: resolveEnabledPlatformsForBusiness(businessId) });
  check('permission_and_platform', access.decision === 'approval_required', access.decision === 'approval_required' ? 'Permitted for Shopify, and only with your signed approval.' : access.reason);
  const eligible = checks.every((entry) => entry.passed);

  appendAuditEvent(runAuditTracker, {
    type: 'result',
    toolId: tool.id,
    status: eligible ? 'eligible' : 'not_eligible',
    summary:
      `Read-only proposal check for '${resolution.source.product_reference}': current values ${readFailure ? 'unknown' : allMatchBefore ? 'match' : 'do not match'} the before-values; ` +
      `${eligible ? 'eligible' : 'not eligible'} for execution. No approval was created, approved or executed, and nothing was written.`,
  });

  return respond(
    { status: 'planned', clarification_type: null, reason: null, candidates: null, unmatched_segment: null, plan: [readStep] },
    {
      growthOpportunityDrafts: [],
      pendingApprovals: runApprovalTracker.requests,
      proposalCheck: {
        status: 'checked',
        source_approval_id: resolution.source.approval_id,
        source_approval_status: resolution.source.approval_status,
        product_reference: resolution.source.product_reference,
        product_id: productId,
        fields,
        read_failure: readFailure,
        all_match_before: allMatchBefore,
        eligible_for_execution: eligible,
        checks,
        ...noWrite,
      },
    }
  );
}

// Answers a vendor correction request (agent/core/vendorCorrectionRequest.js).
//
//   propose - reads the store through the gated Product read, resolves the ONE product by its exact title, checks
//             a stated current vendor against the store and validates the new vendor, then asks for
//             shopify_vendor_correction through the ordinary gated path: compliance is evaluated and ONE pending
//             approval is created for the owner's signature. Nothing is written - the correction runs only after a
//             verified signed approval, through integrations/approvedCorrectionDispatch.js.
//   review  - reads the stored vendor corrections for this business (and the store, to identify the product) and
//             reports each one's exact proposed change and approval status. Creates, approves and executes nothing.
// Anything missing, ambiguous or inconsistent is a question back, with no approval.
async function runVendorCorrection({ objective, decision, businessId, runId, runAuditTracker, runUsageLedger }) {
  const tool = getToolById(vendorCorrection.TOOL_ID);
  const respond = (routing, extra = {}) =>
    buildRoutingResponse({
      objective,
      routing,
      auditTrail: runAuditTracker.events,
      usageLedger: runUsageLedger.events,
      usageSummary: summarizeUsage(runUsageLedger),
      ...extra,
    });
  const base = { kind: decision.kind, store_writes: 0 };
  const clarify = (clarificationType, reason, detail = {}) => {
    appendAuditEvent(runAuditTracker, { type: 'agent', toolId: tool.id, status: 'not_resolved', summary: `Vendor correction ${decision.kind} not completed: ${reason}` });
    return respond(
      { status: 'clarification_required', clarification_type: clarificationType, reason, candidates: null, unmatched_segment: null, plan: null },
      { vendorCorrectionResult: { ...base, status: 'not_resolved', reason, approvals_created: 0, ...detail } }
    );
  };

  if ((decision.additional_requests || []).length > 0) {
    return clarify(
      'vendor_correction_mixed',
      `This message asks about a vendor correction and also for something else (${decision.additional_requests.map((clause) => `"${clause}"`).join(', ')}). Send the other request separately so each gets its own checks. Nothing was changed.`,
      { additional_requests: decision.additional_requests }
    );
  }

  const parsed = decision.parsed;
  const approvalIdNamed = (String(objective || '').match(/\b[\w-]*apr-\d+\b/) || [])[0] || null;
  if (decision.kind === 'propose' && !parsed.product_name) {
    return clarify('vendor_correction_missing_parameters', 'Which product\'s vendor should change? Name the product exactly as it appears in your store, in quotes. No approval was created and nothing was changed.');
  }
  if (decision.kind === 'propose' && !parsed.to_vendor) {
    return clarify('vendor_correction_missing_parameters', `What should the vendor of "${parsed.product_name}" become? State the new vendor, in quotes. No approval was created and nothing was changed.`);
  }
  if (decision.kind === 'review' && !parsed.product_name && !approvalIdNamed) {
    const stored = vendorCorrection.listStoredVendorCorrections({ businessId });
    return clarify(
      'vendor_correction_missing_parameters',
      stored.length === 0
        ? 'There is no vendor correction stored in the approval system for this business. Nothing was changed.'
        : `Which product's vendor correction? Vendor corrections are stored for: ${[...new Set(stored.map((entry) => entry.product_reference || entry.product_id))].slice(0, 10).map((name) => `"${name}"`).join(', ')}. Nothing was changed.`
    );
  }

  // ONE read of the store's products, through the gated Product read.
  const basis = STORE_RESEARCH_BASIS[0];
  const readStep = await buildPlanStep(
    buildSpecialistTarget(basis.specialistId),
    objective,
    objective,
    { tokensUsedThisRun: 0 },
    null,
    [],
    { requests: [], id_prefix: runId },
    runAuditTracker,
    createToolResultCache(),
    createUsageTracker(),
    businessId,
    runUsageLedger,
    { toolId: basis.toolId, capabilityId: basis.capabilityId },
    null
  );
  const sources = readStep.completion_state === 'complete' && readStep.outputs && Array.isArray(readStep.outputs.listing_sources)
    ? readStep.outputs.listing_sources
    : null;

  if (decision.kind === 'review') {
    return reviewVendorCorrections({ objective, parsed, approvalIdNamed, sources, readStep, businessId, runAuditTracker, respond, clarify, base });
  }

  if (!sources) {
    return clarify('vendor_correction_store_unreadable', 'Your Shopify products could not be read, so the product and its current vendor could not be confirmed. No approval was created and nothing was changed.', { read_error: readStep.errors && readStep.errors[0] ? readStep.errors[0] : null });
  }
  const found = vendorCorrection.resolveStoreProduct(sources, parsed.product_name);
  if (found.status === 'ambiguous') {
    return clarify('vendor_correction_product_ambiguous', `More than one product in your store is titled "${parsed.product_name}" (${found.candidates.map((entry) => entry.product_id).join(', ')}). Name the product id to change. No approval was created and nothing was changed.`, { candidates: found.candidates });
  }
  if (found.status !== 'resolved') {
    const similar = found.candidates.length > 0 ? ` Similar titles: ${found.candidates.map((entry) => `"${entry.title}"`).join(', ')}.` : '';
    return clarify('vendor_correction_product_not_found', `No product in your store is titled exactly "${parsed.product_name}".${similar} No approval was created and nothing was changed.`, { candidates: found.candidates });
  }
  const product = found.product;
  if (product.vendor === null) {
    return clarify('vendor_correction_store_unreadable', `The store read did not return the current vendor of "${product.title}", so the change could not be confirmed. No approval was created and nothing was changed.`);
  }
  if (parsed.from_vendor !== null && product.vendor.trim() !== parsed.from_vendor.trim()) {
    return clarify(
      'vendor_correction_current_mismatch',
      `"${product.title}" currently has the vendor "${product.vendor}" in your store, not "${parsed.from_vendor}". No approval was created and nothing was changed.`,
      { product_id: product.product_id, product_reference: product.title, current_vendor: product.vendor }
    );
  }
  const checked = vendorCorrection.validateNewVendor(parsed.to_vendor, product.vendor);
  if (!checked.ok) {
    return clarify('vendor_correction_invalid_parameters', `${checked.reason} No approval was created and nothing was changed.`, { product_id: product.product_id, product_reference: product.title, current_vendor: product.vendor });
  }

  const change = { product_id: product.product_id, product_reference: product.title, current_vendor: product.vendor, new_vendor: checked.value };
  // The same change already waiting for, or holding, the owner's approval is shown, never requested twice.
  const open = vendorCorrection
    .listStoredVendorCorrections({ businessId })
    .find((entry) => vendorCorrection.isOpenCorrection(entry) && entry.product_id === product.product_id && entry.new_vendor === checked.value);
  if (open) {
    appendAuditEvent(runAuditTracker, { type: 'agent', toolId: tool.id, status: 'existing', summary: `Vendor correction for '${product.title}' to '${checked.value}' already exists as approval '${open.approval_id}' (${open.approval_status}); no new approval was created.` });
    return respond(
      { status: 'planned', clarification_type: null, reason: null, candidates: null, unmatched_segment: null, plan: [readStep] },
      { growthOpportunityDrafts: [], pendingApprovals: [], vendorCorrectionResult: { ...base, status: 'existing', approvals_created: 0, ...change, approval_id: open.approval_id, approval_status: open.approval_status, execution_state: open.execution_state } }
    );
  }

  const researchParams = {
    platform: vendorCorrection.PLATFORM,
    proposal_kind: vendorCorrection.PROPOSAL_KIND,
    productId: product.product_id,
    productReference: product.title,
    currentVendor: product.vendor,
    newVendor: checked.value,
    storeReference: currentStoreReference({ businessId }),
  };
  const executionRequest = createExecutionRequest(objective, { category: tool.category, tool }, researchParams, businessId);
  const alreadyVerified = checkCorrectionAlreadyVerified(tool.id, executionRequest);
  if (!alreadyVerified.allowed) {
    return clarify('vendor_correction_already_applied', `The vendor of "${product.title}" has already been changed to "${checked.value}" and verified, so no new approval was created. Nothing was changed.`, change);
  }

  const runApprovalTracker = { requests: [], id_prefix: runId };
  const outcome = await executeSelectedCapability(executionRequest, { tokensUsedThisRun: 0 }, runApprovalTracker, runAuditTracker, null, createUsageTracker(), runUsageLedger);
  const step = deriveExecutionState({
    request: objective,
    currentTask: objective,
    target: buildSpecialistTarget(executionRequest.specialist_id),
    category: tool.category,
    toolId: tool.id,
    capabilityId: null,
    inputContract: null,
    requiredContextIds: gatherMinimumContext(executionRequest).map((boundary) => boundary.id),
    outcome,
    verificationStatus: validateResult(outcome),
    approvalRequestId: outcome ? outcome.approval_request_id || null : null,
  });
  const awaiting = Boolean(outcome && outcome.status === 'approval_required' && outcome.approval_request_id);
  return respond(
    { status: 'planned', clarification_type: null, reason: null, candidates: null, unmatched_segment: null, plan: [readStep, step] },
    {
      growthOpportunityDrafts: [],
      pendingApprovals: runApprovalTracker.requests,
      vendorCorrectionResult: {
        ...base,
        status: awaiting ? 'awaiting_approval' : 'not_created',
        approvals_created: runApprovalTracker.requests.length,
        ...change,
        approval_id: awaiting ? outcome.approval_request_id : null,
        approval_status: awaiting ? 'pending' : null,
        compliance_status: runApprovalTracker.requests[0] && runApprovalTracker.requests[0].execution_request && runApprovalTracker.requests[0].execution_request.compliance
          ? runApprovalTracker.requests[0].execution_request.compliance.compliance_status || null
          : null,
        reason: awaiting ? null : (outcome && outcome.error) || 'No approval could be created.',
      },
    }
  );
}

// The review half of runVendorCorrection: stored vendor corrections for the named product or approval id, each
// with its exact proposed change and approval status, beside the store's current vendor. Read-only.
function reviewVendorCorrections({ objective, parsed, approvalIdNamed, sources, readStep, businessId, runAuditTracker, respond, clarify, base }) {
  const stored = vendorCorrection.listStoredVendorCorrections({ businessId });
  let matched;
  let product = null;
  if (approvalIdNamed) {
    matched = stored.filter((entry) => entry.approval_id === approvalIdNamed);
  } else {
    const found = sources ? vendorCorrection.resolveStoreProduct(sources, parsed.product_name) : { status: 'unread', candidates: [] };
    if (found.status === 'resolved') product = found.product;
    const nameKey = String(parsed.product_name || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const productIds = found.status === 'resolved' ? [found.product.product_id] : found.status === 'ambiguous' ? found.candidates.map((entry) => entry.product_id) : [];
    matched = stored.filter((entry) => productIds.includes(entry.product_id) || (entry.product_reference && entry.product_reference.replace(/\s+/g, ' ').trim().toLowerCase() === nameKey));
  }
  appendAuditEvent(runAuditTracker, {
    type: 'data_access',
    toolId: vendorCorrection.TOOL_ID,
    status: matched.length > 0 ? 'resolved' : 'not_resolved',
    summary: `Read-only vendor correction lookup: ${stored.length} stored vendor correction(s) for this business, ${matched.length} for the request. No approval was created, approved or executed.`,
  });
  const target = approvalIdNamed ? `approval ${approvalIdNamed}` : `"${parsed.product_name}"`;
  if (matched.length === 0) {
    const unreadable = !approvalIdNamed && !sources ? ' Your Shopify products could not be read, so a correction recorded only by product id could not be matched.' : '';
    return clarify(
      'vendor_correction_not_found',
      `No vendor correction is stored in the approval system for ${target}.${unreadable} (SEO proposals are separate and were not considered.) Nothing was created, approved, executed or changed.`,
      { stored_vendor_corrections: stored.length }
    );
  }
  const corrections = matched.map((entry) => {
    const live = sources ? sources.find((source) => source && source.shopify_product_id === entry.product_id) : null;
    const liveVendor = live && live.store_fields && !((live.store_fields.unavailable_fields || []).includes('vendor')) ? live.store_fields.vendor : null;
    return { ...entry, product_reference: entry.product_reference || (live ? live.product_reference : null), store_vendor_now: liveVendor };
  });
  return respond(
    { status: 'planned', clarification_type: null, reason: null, candidates: null, unmatched_segment: null, plan: [readStep] },
    {
      growthOpportunityDrafts: [],
      pendingApprovals: [],
      vendorCorrectionResult: { ...base, status: 'found', approvals_created: 0, product_id: product ? product.product_id : null, corrections },
    }
  );
}

// Answers an objective that asks to apply an existing proposal (agent/core/proposalExecution.js).
//
// Resolves the ONE stored proposal and the exact fields meant, then asks for the store change through
// the same executeSelectedCapability every gated step uses - permissions, the platform gate, the source
// gate (gate 3), compliance, approval creation and audit all apply unchanged - as a single plan step, so
// /orchestrate/approve can fold the approved execution back into it. Nothing is written here: the
// only outcome is a pending approval, or a question back with no approval.
async function runProposalExecution({ objective, decision, businessId, researchContext, runId, runAuditTracker, runUsageLedger }) {
  const respond = (routing, extra = {}) =>
    buildRoutingResponse({
      objective,
      routing,
      auditTrail: runAuditTracker.events,
      usageLedger: runUsageLedger.events,
      usageSummary: summarizeUsage(runUsageLedger),
      ...extra,
    });
  const clarify = (clarificationType, reason, proposalExecution) => {
    appendAuditEvent(runAuditTracker, { type: 'agent', status: 'not_resolved', summary: `Proposal execution not started: ${reason}` });
    return respond(
      { status: 'clarification_required', clarification_type: clarificationType, reason, candidates: null, unmatched_segment: null, plan: null },
      { proposalExecution: { status: 'not_started', store_writes: 0, ...proposalExecution } }
    );
  };

  // Another operation in the same message is not silently dropped while the proposal is applied.
  if (decision.additional_requests.length > 0) {
    return clarify(
      'proposal_execution_mixed',
      `This message asks to apply an existing proposal and also to do something else (${decision.additional_requests.map((clause) => `"${clause}"`).join(', ')}). ` +
        'Send the other request separately so each gets its own checks. Nothing was changed.',
      { additional_requests: decision.additional_requests }
    );
  }

  const resolution = resolveProposalExecution({
    objective,
    executionText: decision.execution_text,
    businessId,
    storeReference: researchContext && typeof researchContext.store_reference === 'string' ? researchContext.store_reference : undefined,
  });
  appendAuditEvent(runAuditTracker, {
    type: 'data_access',
    status: resolution.status,
    summary:
      resolution.status === 'resolved'
        ? `Resolved the request to stored SEO proposal '${resolution.source.approval_id}' for '${resolution.source.product_reference}' (${resolution.applied_changes.map((change) => change.shopify_field).join(', ')}).`
        : `Looked up stored SEO proposals (${resolution.considered.proposals} for this business): ${resolution.status}.`,
  });
  if (resolution.status !== 'resolved') {
    return clarify(resolution.status === 'ambiguous' ? 'proposal_ambiguous' : 'proposal_not_resolved', resolution.reason, {
      candidates: resolution.candidates,
    });
  }

  const tool = getToolById(PROPOSAL_APPLICATION_TOOL_ID);
  const executionRequest = createExecutionRequest(objective, { category: tool.category, tool }, resolution.research_params, businessId);
  const described = {
    tool_id: tool.id,
    source_approval_id: resolution.source.approval_id,
    source_approval_status: resolution.source.approval_status,
    product_reference: resolution.source.product_reference,
    product_id: resolution.research_params.productId,
    applied_changes: resolution.applied_changes,
    not_applied: resolution.not_applied,
    answered_by_execution: decision.answered_by_execution,
    // The owner's own "require my signed approval before writing" - enforced by the approval gate below,
    // recorded so the reply can say where it is enforced.
    approval_requirements: decision.approval_requirements || [],
  };

  // "Review the latest Shopify SEO research ...": the research referred to must be the proposal's own basis,
  // confirmed from the run record - otherwise the owner is asked, and no approval is created.
  const researchReferences = decision.research_references || [];
  if (researchReferences.length > 0) {
    const basis = resolveProposalResearchBasis({
      sourceRunId: resolution.research_params.sourceRunId,
      businessId,
      storeReference: resolution.research_params.storeReference,
      latestResearch: researchContext && researchContext.research ? researchContext.research : null,
    });
    appendAuditEvent(runAuditTracker, {
      type: 'data_access',
      status: basis.found ? 'resolved' : 'not_resolved',
      summary: basis.found
        ? `The referenced research is the proposal's own basis, run '${basis.source_run_id}'.`
        : `The referenced research could not be confirmed as the proposal's basis: ${basis.reason}`,
    });
    if (!basis.found) {
      return clarify('proposal_research_not_found', `${basis.reason} Nothing was changed.`, { ...described, research_references: researchReferences });
    }
    described.research_references = researchReferences;
    described.research_basis = basis;
  }

  // An exact change already applied and independently verified is never asked for again.
  const alreadyVerified = checkCorrectionAlreadyVerified(tool.id, executionRequest);
  if (!alreadyVerified.allowed) {
    return clarify(
      'proposal_already_applied',
      `The proposed ${resolution.applied_changes.map((change) => change.shopify_field).join(' and ')} for "${resolution.source.product_reference}" has already been applied and verified, so no new approval was created. Nothing was changed.`,
      described
    );
  }

  const runApprovalTracker = { requests: [], id_prefix: runId };
  const outcome = await executeSelectedCapability(
    executionRequest,
    { tokensUsedThisRun: 0 },
    runApprovalTracker,
    runAuditTracker,
    null,
    createUsageTracker(),
    runUsageLedger
  );
  const step = deriveExecutionState({
    request: objective,
    currentTask: decision.execution_text,
    target: buildSpecialistTarget(executionRequest.specialist_id),
    category: tool.category,
    toolId: tool.id,
    capabilityId: null,
    inputContract: null,
    requiredContextIds: gatherMinimumContext(executionRequest).map((boundary) => boundary.id),
    outcome,
    verificationStatus: validateResult(outcome),
    approvalRequestId: outcome ? outcome.approval_request_id || null : null,
  });

  return respond(
    { status: 'planned', clarification_type: null, reason: null, candidates: null, unmatched_segment: null, plan: [step] },
    {
      growthOpportunityDrafts: [],
      pendingApprovals: runApprovalTracker.requests,
      proposalExecution: {
        status: outcome && outcome.status === 'approval_required' ? 'awaiting_approval' : 'not_created',
        store_writes: 0,
        ...described,
        approval_id: outcome && outcome.approval_request_id ? outcome.approval_request_id : null,
        reason: outcome && outcome.status !== 'approval_required' ? outcome.error || null : null,
      },
    }
  );
}

// The phrase buildPlanStep's missing-evidence stop uses, shared so the dependency check in
// runOrchestratorContract recognises exactly that stop and nothing else (a denied permission
// or an unavailable tool also leaves outputs null, and must not trigger a provider read).
const MISSING_EVIDENCE_MARKER = 'needs real, structured input';

// Whether a clause is about the PROVIDER specialist's subject, not merely sharing words with
// it. Only words distinctive to the provider count: words in its routing text that are NOT
// in the dependent specialist's routing text and are not generic routing words. Measured:
// "SEO keyword research for insulated hiking jackets" scores for Product only on "research",
// which SEO's own text also contains - so it is not about the store's products and gets no
// Product read, while "Review the SEO findings from my Shopify products" is, on "shopify" and
// "products". Uses the existing ROUTING_TARGETS text only - no new vocabulary.
function clauseDistinctlyAbout(clauseText, providerSpecialistId, dependentSpecialistId) {
  const targetText = (id) => {
    const target = ROUTING_TARGETS.find((entry) => entry.type === 'specialist' && entry.id === id);
    return target ? target.text : '';
  };
  const dependentWords = new Set(tokenize(targetText(dependentSpecialistId)));
  const distinctive = new Set(
    tokenize(targetText(providerSpecialistId)).filter((word) => !dependentWords.has(word) && !GENERIC_ROUTING_WORDS.has(word))
  );
  return tokenize(clauseText).some((word) => distinctive.has(word));
}

function stoppedForMissingEvidence(step) {
  return (
    Boolean(step) &&
    step.outputs === null &&
    (step.errors || []).some((error) => String((error && error.message) || error).includes(MISSING_EVIDENCE_MARKER))
  );
}

function planHasProviderResult(plan, provider) {
  return plan.some(
    (step) =>
      step.selected_specialist &&
      step.selected_specialist.id === provider.fromSpecialistId &&
      step.inputs &&
      step.inputs.capability_id === provider.fromCapabilityId &&
      step.outputs &&
      step.outputs.status === 'success'
  );
}

module.exports = {
  CATEGORY_TO_SPECIALIST,
  SPECIALIST_TO_CATEGORIES,
  SHARED_INFRASTRUCTURE_CATEGORIES,
  ROUTING_TARGETS,
  understandObjective,
  identifyRequiredCapability,
  needsMoreInformation,
  createExecutionRequest,
  selectSpecialist,
  gatherMinimumContext,
  runExecutor,
  executeSelectedCapability,
  prepareApprovalExecutionRequest,
  resolveEnabledPlatformsForBusiness,
  resumeApprovedExecution,
  validateResult,
  scoreRoutingTargets,
  splitIntoClauses,
  routeClause,
  resolveObjectiveIntent,
  planRouting,
  // Exported so verification/testing/catalogueExpansionRouting.test.js can assert the
  // intent gate directly, separately from what word-overlap scoring then does with a
  // clause the gate declined.
  hasCatalogueExpansionIntent,
  attemptAiAssistedSegmentation,
  runVendorCorrection,
  extractJsonArray,
  buildPlanStep,
  buildSpecialistTarget,
  buildSharedInfrastructureTarget,
  isGatedForApproval,
  reviseStepAfterResume,
  aggregatePlanState,
  buildRoutingResponse,
  runOrchestratorContract,
  deriveBusinessConfigContext,
  BUSINESS_CONFIG_PATH,
};

if (require.main === module) {
  const sampleTasks = [
    '',
    'keyword search visibility',
    'improve my listing content',
    'market competitor research and social media advertising',
    'I need content optimization help',
    "check my shop's business configuration",
  ];

  (async () => {
    console.log('Smart E-Commerce Growth AI Agent - orchestrator structured routing:\n');
    for (const task of sampleTasks) {
      console.log(`--- Task: ${JSON.stringify(task)} ---`);
      const response = await runOrchestratorContract(task);
      console.log(JSON.stringify(response, null, 2));
      console.log('');
    }
  })();
}
