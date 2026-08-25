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
const { getContextBoundaries } = require('./contextBoundaries');
const { createEmptyState } = require('./stateModel');
const { deriveExecutionState } = require('./executionState');
const {
  CATEGORY_TO_SPECIALIST,
  SPECIALIST_TO_CATEGORIES,
  SHARED_INFRASTRUCTURE_CATEGORIES,
  checkToolAccess,
} = require('./toolPermissions');
const businessConfigurationRetrieval = require('../../tools/businessConfigurationRetrieval');
const aiReasoningCompletion = require('../../tools/aiReasoningCompletion');
const marketResearchTool = require('../../tools/marketResearchTool');
const competitorResearchTool = require('../../tools/competitorResearchTool');
const customerResearchTool = require('../../tools/customerResearchTool');
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
  business_configuration_retrieval: () =>
    businessConfigurationRetrieval.retrieveBusinessConfiguration(),
  ai_reasoning_completion: (executionRequest, runTokenTracker) =>
    aiReasoningCompletion.runReasoningCompletion({
      instruction: executionRequest.objective,
      tokensUsedThisRun: runTokenTracker.tokensUsedThisRun,
    }),
  market_research: (executionRequest) =>
    marketResearchTool.runMarketResearchTool(executionRequest.research_params),
  competitor_research: (executionRequest) =>
    competitorResearchTool.runCompetitorResearchTool(executionRequest.research_params),
  customer_research: (executionRequest) =>
    customerResearchTool.runCustomerResearchTool(executionRequest.research_params),
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
    analyticsDataTool.runAnalyticsDataTool(executionRequest.research_params),
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
function createExecutionRequest(objective, capability, researchParams = null) {
  const category = capability.category;
  const specialistId = CATEGORY_TO_SPECIALIST[category] || null;
  return {
    objective,
    category,
    tool_id: capability.tool.id,
    specialist_id: specialistId,
    is_shared_infrastructure: specialistId === null,
    research_params: researchParams,
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
async function executeSelectedCapability(executionRequest, runTokenTracker = { tokensUsedThisRun: 0 }) {
  const access = checkToolAccess({
    specialistId: executionRequest.specialist_id,
    toolId: executionRequest.tool_id,
  });

  if (access.decision === 'unavailable') {
    return {
      status: access.tool_id ? 'not_available' : 'error',
      data: null,
      error: access.tool_id ? access.reason : `Unknown tool: ${executionRequest.tool_id}`,
      classification: null,
    };
  }

  if (access.decision === 'denied') {
    return { status: 'denied', data: null, error: access.reason, classification: null };
  }

  if (access.decision === 'approval_required') {
    return {
      status: 'approval_required',
      data: null,
      error: access.reason,
      classification: access.classification,
    };
  }

  const executor = TOOL_EXECUTORS[access.tool_id];
  if (!executor) {
    return {
      status: 'error',
      data: null,
      error: `No executor is wired for implemented tool '${access.tool_id}'.`,
      classification: access.classification,
    };
  }

  try {
    const data = await executor(executionRequest, runTokenTracker);
    return { status: 'success', data, error: null, classification: access.classification };
  } catch (err) {
    return { status: 'error', data: null, error: err.message, classification: access.classification };
  }
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
  researchParams = null
) {
  const capabilityEntry = target.type === 'specialist' ? getSpecialistCapabilityById(target.id) : null;
  const candidateToolIds = capabilityEntry
    ? capabilityEntry.required_tools
    : target.type === 'shared_infrastructure'
      ? getToolsByCategory(target.id).map((tool) => tool.id)
      : [];

  const objectiveWords = new Set(tokenize(objective));
  let toolMatch = null;
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
    matchedCapability = bestMatchingTask(candidateTasks, objectiveWords);
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
      research_params: researchParams,
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
      researchParams
    );
    outcome = await executeSelectedCapability(executionRequest, runTokenTracker);
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

// Assembles the final structured response around a routing result - state (in-memory
// only, never persisted, see module header) plus every field the caller needs.
// tokensUsedThisRun surfaces agent/core/tokenControls.js's running total so token
// usage is visible in the response, not just enforced silently inside execution.
function buildRoutingResponse({ objective, routing, tokensUsedThisRun = 0 }) {
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
    const errors = routing.plan.flatMap((step) => step.errors || []);
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
async function runOrchestratorContract(rawTask, { researchParams = null } = {}) {
  let objective;
  try {
    objective = understandObjective(rawTask);
  } catch (err) {
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
    });
  }

  const routingResult = planRouting(objective);

  if (routingResult.status === 'clarification_required') {
    return buildRoutingResponse({
      objective,
      routing: { ...routingResult, plan: null },
    });
  }

  // One tracker per run, threaded through every plan step - see buildPlanStep and
  // executeSelectedCapability above. This is what lets agent/core/tokenControls.js
  // enforce a budget across the whole run, not just per call.
  const runTokenTracker = { tokensUsedThisRun: 0 };

  const plan = [];
  for (let i = 0; i < routingResult.targets.length; i += 1) {
    plan.push(
      await buildPlanStep(
        routingResult.targets[i],
        objective,
        routingResult.segments[i],
        runTokenTracker,
        researchParams
      )
    );
  }

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
  executeSelectedCapability,
  validateResult,
  scoreRoutingTargets,
  splitIntoClauses,
  routeClause,
  planRouting,
  buildPlanStep,
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
