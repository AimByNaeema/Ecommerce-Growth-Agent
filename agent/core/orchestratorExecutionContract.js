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

const { TOOL_REGISTRY, getToolsByCategory, getToolById } = require('../../tools/toolRegistry');
const { getSpecialistById } = require('./specialistRegistry');
const { getSpecialistCapabilityRegistry, getSpecialistCapabilityById } = require('./specialistCapabilityRegistry');
const {
  deriveCrossAgentContext,
  deriveAllToAnalyticsContext,
  gatherGrowthOpportunityDrafts,
  mergeContext,
  dedupeArray,
} = require('./crossAgentContext');
const { getContextBoundaries } = require('./contextBoundaries');
const { createEmptyState } = require('./stateModel');
const { deriveExecutionState } = require('./executionState');
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
const businessConfigurationRetrieval = require('../../tools/businessConfigurationRetrieval');
const aiReasoningCompletion = require('../../tools/aiReasoningCompletion');
const marketResearchTool = require('../../tools/marketResearchTool');
const competitorResearchTool = require('../../tools/competitorResearchTool');
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
// auditable than relying on incidental key uniqueness.
const NEVER_CACHED_TOOL_IDS = new Set(['ai_reasoning_completion']);

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
function validateResult(outcome) {
  if (!outcome || typeof outcome !== 'object' || !('status' in outcome)) {
    return 'failed';
  }
  if (outcome.status === 'success' && outcome.data) {
    return 'passed';
  }
  if (outcome.status === 'error') {
    return 'failed';
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
function buildRoutingTargets() {
  const specialistTargets = getSpecialistCapabilityRegistry().map((specialist) => ({
    type: 'specialist',
    id: specialist.id,
    title: specialist.title,
    text: `${specialist.id} ${specialist.title} ${specialist.description}`,
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
      if (words.has(word)) score += 1;
    }
    return { target, score };
  })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
}

// Splits an objective into independent clauses on common conjunctions/list
// separators, so a multi-part request ("research X and optimize Y") can be routed to
// more than one target instead of forcing a single pick.
const CLAUSE_SPLIT_REGEX = /\s*(?:,|;|\band\b|\balso\b|\bas well as\b|\bthen\b|\bplus\b)\s*/i;

function splitIntoClauses(objective) {
  return objective
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
  const tied = scored.filter((entry) => entry.score === topScore);
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

  const orderedEntries = [];
  const seen = new Set();

  for (const clause of clauses) {
    const result = routeClause(clause);

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
// beyond that deterministic, documented tie-break.
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
  forcedSelection = null
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

  const objectiveWords = new Set(tokenize(objective));
  let toolMatch = null;

  if (forcedSelection && forcedSelection.toolId && candidateToolIds.includes(forcedSelection.toolId)) {
    toolMatch = getToolById(forcedSelection.toolId) || null;
  }

  if (!toolMatch) {
    let bestScore = 0;
    for (const toolId of candidateToolIds) {
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
  if (!toolMatch && candidateToolIds.length > 0) {
    toolMatch = getToolById(candidateToolIds[0]) || null;
  }

  const matchedCategory = toolMatch ? toolMatch.category : null;

  // Which declared capability (agent/core/specialistCapabilityModel.js's
  // CAPABILITY_TASK_FIELDS shape) the matched tool actually serves - null (never
  // guessed) when the tool serves zero capabilities in the registry, or when this
  // target has no capability entry at all (shared infrastructure).
  let matchedCapability = null;
  if (capabilityEntry && toolMatch) {
    const candidateTasks = capabilityEntry.supported_tasks.filter((task) => task.tool_ids.includes(toolMatch.id));
    matchedCapability =
      forcedSelection && forcedSelection.capabilityId
        ? candidateTasks.find((task) => task.id === forcedSelection.capabilityId) || null
        : bestMatchingTask(candidateTasks, objectiveWords);
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
    let derivedContext = mergeContext({}, selectorContext);
    derivedContext = mergeContext(derivedContext, pairContext);
    derivedContext = mergeContext(derivedContext, analyticsContext);

    if (Object.keys(derivedContext).length > 0) {
      effectiveResearchParams = { ...derivedContext, ...(researchParams || {}) };
    }
  }

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

  const routingResult = planRouting(objective);

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

  const plan = [];
  for (let i = 0; i < routingResult.targets.length; i += 1) {
    // plan already holds every step completed so far (0..i-1) at this point - passed
    // as priorSteps so buildPlanStep can derive structured cross-agent context for
    // this step from them (see agent/core/crossAgentContext.js).
    plan.push(
      await buildPlanStep(
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
        runUsageLedger
      )
    );
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
  buildPlanStep,
  buildSpecialistTarget,
  isGatedForApproval,
  reviseStepAfterResume,
  aggregatePlanState,
  buildRoutingResponse,
  runOrchestratorContract,
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
