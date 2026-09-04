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

const path = require('path');
const { TOOL_REGISTRY, getToolsByCategory, getToolById } = require('../../tools/toolRegistry');
const { loadBusinessConfig } = require('../../tools/configValidator');
const { getSpecialistById } = require('./specialistRegistry');
const { getSpecialistCapabilityRegistry, getSpecialistCapabilityById } = require('./specialistCapabilityRegistry');
const {
  deriveCrossAgentContext,
  deriveAllToAnalyticsContext,
  deriveLiveEvidenceContext,
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
const { isValidBusinessId } = require('../../configuration/businessRegistry');
// The Memory layer's own connection into this run flow (agent/core/memoryStore.js's
// business-isolated storage + agent/core/memoryRecordModel.js's verified/approved
// gate) - see agent/core/memoryContextRetrieval.js's own header for the full scope
// this wiring is (and is deliberately not) responsible for.
const { getRelevantMemoryContext, persistVerifiedFinding } = require('./memoryContextRetrieval');
// One honest, compact sentence per finished execution state (agent/core/resultSummary.js) -
// reused unchanged as the memory record's own `summary` (memoryRules.js's "compact"
// quality) rather than inventing a second summarization path.
const { summarizeExecutionState } = require('./resultSummary');
const businessConfigurationRetrieval = require('../../tools/businessConfigurationRetrieval');
const aiReasoningCompletion = require('../../tools/aiReasoningCompletion');
const marketResearchTool = require('../../tools/marketResearchTool');
const competitorResearchTool = require('../../tools/competitorResearchTool');
const webCompetitorResearchTool = require('../../tools/webCompetitorResearchTool');
const customerResearchTool = require('../../tools/customerResearchTool');
const globalMarketOpportunityTool = require('../../tools/globalMarketOpportunityTool');
const marketProductOpportunityTool = require('../../tools/marketProductOpportunityTool');
const keywordResearchTool = require('../../tools/keywordResearchTool');
const seoAnalysisTool = require('../../tools/seoAnalysisTool');
const listingContentTool = require('../../tools/listingContentTool');
const marketingAnalysisTool = require('../../tools/marketingAnalysisTool');
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
const collectionDataRetrievalTool = require('../../tools/collectionDataRetrievalTool');

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
      ...(executionRequest.research_params || {}),
      businessId: executionRequest.business_id,
    }),
  collection_data_retrieval: (executionRequest) =>
    collectionDataRetrievalTool.retrieveCollectionData({
      ...(executionRequest.research_params || {}),
      businessId: executionRequest.business_id,
    }),
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

  let best = null;
  let bestScore = 0;
  for (const tool of TOOL_REGISTRY) {
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
    const data = await executor(executionRequest, runTokenTracker);
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

  if (access.decision === 'approval_required') {
    // Real, trackable pending request - see approvals/approvalWorkflow.js. Never
    // executes here; execution only ever happens via resumeApprovedExecution() below,
    // once a real, accountable decideApprovalRequest(..., { decision: 'approved' })
    // call has happened (CLAUDE.md rule 7 - never silently perform a consequential
    // action). The id is deterministic per run (no randomness), matching every other
    // record in this project.
    const approvalRequest = createApprovalRequest({
      id: `apr-${runApprovalTracker.requests.length + 1}`,
      classification: access.classification,
      specialistId: executionRequest.specialist_id,
      toolId: access.tool_id,
      executionRequest,
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
  runUsageLedger = null
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

  const access = checkToolAccess({
    specialistId: decidedApprovalRequest.specialist_id,
    toolId: decidedApprovalRequest.tool_id,
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
const ROUTING_SYNONYMS = {
  analytics_optimization: ['analyze', 'analysis', 'business', 'ecommerce', 'commerce', 'orders'],
  product: ['shopify', 'products'],
  seo: ['keywords'],
  listing: ['listings', 'titles'],
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
const GENERIC_ROUTING_WORDS = new Set(['business', 'analyze', 'information', 'help', 'check', 'data', 'product']);
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

function splitIntoClauses(objective) {
  return protectFileFormatLists(objective)
    .split(CLAUSE_SPLIT_REGEX)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
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

        routedClauses[neighborIndex] = { text: mergedText, result: mergedResult };
        routedClauses[i] = { text: mergedText, result: { status: 'absorbed' } };
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

// Routes a full objective into a controlled, ordered execution plan: splits into
// clauses, routes each one, and combines the results. Any ambiguous or unmatched
// clause stops the whole request and reports a clarification requirement instead of
// guessing at the rest. Matched clauses are deduped by target and ordered to match
// ROUTING_TARGETS's fixed order, so the same objective always produces the same plan.
function planRouting(objective) {
  const clauses = splitIntoClauses(objective);

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
  const routedClauses = attemptClauseRecovery(
    clauses.map((clause) => ({ text: clause, result: routeClause(clause) }))
  );

  const orderedEntries = [];
  const seen = new Set();

  for (const { result } of routedClauses) {
    if (result.status === 'absorbed') continue;

    if (result.status === 'unmatched') {
      return {
        status: 'clarification_required',
        clarification_type: 'unmatched',
        reason: `No known capability matches "${result.segment}" - please clarify what you need.`,
        candidates: null,
        unmatched_segment: result.segment,
      };
    }

    if (result.status === 'ambiguous') {
      return {
        status: 'clarification_required',
        clarification_type: 'ambiguous',
        reason: `"${result.segment}" could belong to more than one capability - please clarify which one you mean.`,
        candidates: result.candidates,
        unmatched_segment: null,
      };
    }

    const key = `${result.target.type}:${result.target.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      orderedEntries.push({ target: result.target, segment: result.segment });
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
// tools/socialContentTool.js, tools/paidAdvertisingTool.js).
const TOOL_CAPABILITY_SELECTORS = {
  customer_research: {
    field: 'customerResearchMode',
    valueMap: { customer_market_intelligence: 'segment_research', customer_segmentation: 'customer_segmentation' },
  },
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

function deriveBusinessConfigContext({ toCapabilityId, configPath = BUSINESS_CONFIG_PATH }) {
  if (toCapabilityId !== 'global_market_opportunity_analysis') return {};

  let businessConfig;
  try {
    businessConfig = loadBusinessConfig(configPath);
  } catch (err) {
    return {};
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
function topLevelRequiredFieldsSatisfied(inputContract, params) {
  const required = inputContract && Array.isArray(inputContract.required) ? inputContract.required : [];
  if (required.length === 0) return true;
  if (!params || typeof params !== 'object') return false;
  const topLevelFields = new Set(required.map((field) => field.split(/[.[]/)[0]));
  for (const field of topLevelFields) {
    const value = params[field];
    const present = Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== '';
    if (!present) return false;
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
  const candidateToolIds = capabilityEntry
    ? capabilityEntry.required_tools
    : target.type === 'shared_infrastructure'
      ? getToolsByCategory(target.id).map((tool) => tool.id)
      : [];

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
  const scorableToolIds = candidateToolIds.filter((toolId) => toolId !== 'live_competitor_research');

  if (!toolMatch) {
    let bestScore = 0;
    for (const toolId of scorableToolIds) {
      const tool = getToolById(toolId);
      if (!tool) continue;
      const score = scoreWordOverlap(`${tool.id} ${tool.title} ${tool.description} ${tool.category}`, objectiveWords);
      if (score > bestScore) {
        bestScore = score;
        toolMatch = tool;
      }
    }
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
    derivedContext = mergeContext(derivedContext, relevantMemoryContext || {});

    if (Object.keys(derivedContext).length > 0) {
      effectiveResearchParams = { ...derivedContext, ...(researchParams || {}) };
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
      .filter((field) => {
        const value = effectiveResearchParams && effectiveResearchParams[field];
        return Array.isArray(value) ? value.length === 0 : value === undefined || value === null || value === '';
      });
    outcome = {
      status: 'clarification_required',
      data: null,
      error:
        `'${matchedCapability.title}' needs real, structured input this request did not supply and no ` +
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
    const result = routeClause(clause);
    if (result.status !== 'matched') return null;

    const key = `${result.target.type}:${result.target.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      orderedEntries.push({ target: result.target, segment: result.segment });
    }
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
async function runOrchestratorContract(rawTask, { researchParams = null, businessId = null } = {}) {
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
  if (routingResult.status === 'clarification_required' && routingResult.clarification_type === 'unmatched') {
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
  const planStepBounds = checkPlanStepBounds(routingResult.targets.length);
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
  const runApprovalTracker = { requests: [] };
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

  const plan = [];
  for (let i = 0; i < routingResult.targets.length; i += 1) {
    // plan already holds every step completed so far (0..i-1) at this point - passed
    // as priorSteps so buildPlanStep can derive structured cross-agent context for
    // this step from them (see agent/core/crossAgentContext.js).
    const step = await buildPlanStep(
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
      null,
      relevantMemoryContext
    );
    plan.push(step);

    // MEMORY LAYER - PERSISTENCE (agent/core/memoryContextRetrieval.js): after a
    // specialist (never shared-infrastructure) step completes with
    // verification_status 'passed' (step.completion_state === 'complete' - see
    // deriveExecutionState), save a compact record of it as a reusable finding.
    // Reuses summarizeExecutionState's own already-established, compact, honest
    // sentence unchanged as the record's summary - never a second summarization path.
    // A null/invalid businessId is a documented no-op (see persistVerifiedFinding's
    // own header), so this has no effect for any existing caller.
    if (isValidBusinessId(businessId) && step.selected_specialist && step.selected_specialist.type === 'specialist' && step.completion_state === 'complete') {
      const toolId = step.inputs ? step.inputs.tool_id : null;
      const capabilityId = step.inputs ? step.inputs.capability_id : null;
      const savedRecord = persistVerifiedFinding({
        businessId,
        id: `mem-${runId}-${i}`,
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
    }
  }

  // "Analytics -> Optimization": every growth-opportunity-shaped record produced
  // anywhere in this plan, gathered into draft candidates for the standalone
  // agent/core/growthOpportunityEngine.js - see gatherGrowthOpportunityDrafts's own
  // header for why this never calls rankGrowthOpportunities() automatically.
  const growthOpportunityDrafts = gatherGrowthOpportunityDrafts(plan);

  return buildRoutingResponse({
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
  resumeApprovedExecution,
  validateResult,
  scoreRoutingTargets,
  splitIntoClauses,
  routeClause,
  planRouting,
  attemptAiAssistedSegmentation,
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
