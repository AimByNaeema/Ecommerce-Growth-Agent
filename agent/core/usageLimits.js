'use strict';

// Configurable per-run usage limits: how many real tool calls, model calls,
// research calls, and external API calls a single runOrchestratorContract run may
// make. Complements agent/core/tokenControls.js (token volume) and
// agent/core/executionBounds.js (plan-step/array-size bounds) - a genuinely
// distinct concern (call *counts*, not token volume or input shape), so it gets its
// own module rather than being folded into either of those, matching this
// project's established one-concern-per-module convention.
//
// Classification is a static lookup against agent/core/orchestratorExecutionContract.js's
// TOOL_EXECUTORS ids - never inferred from specialist_id or substring matching,
// since neither cleanly matches the real wired tool set (e.g. keyword_research is a
// research call but is SEO-owned).
//
// Enforced only on the real (cache-miss) dispatch path in runExecutor - a
// agent/core/toolResultCache.js cache hit never consumes budget, since no real call
// is made. A breach fails only the one step that would exceed it (same pattern as
// agent/core/executionBounds.js's checkArrayFieldBounds/checkPlanStepBounds) -
// never a thrown exception, never a silent skip, never an uncontrolled retry.

// The sole path to agent/core/claudeClient.js's sendMessage (via
// tools/aiReasoningCompletion.js).
const MODEL_CALL_TOOL_IDS = new Set(['ai_reasoning_completion']);

// The tool ids that ultimately reach integrations/adapters/shopifyClient.js
// (business_configuration_retrieval, analytics_data_retrieval, product_data_retrieval,
// collection_data_retrieval) or agent/core/claudeClient.js (ai_reasoning_completion) -
// every other TOOL_EXECUTORS entry is pure, deterministic, in-memory logic with no
// external network call.
const EXTERNAL_API_TOOL_IDS = new Set([
  'business_configuration_retrieval',
  'analytics_data_retrieval',
  'product_data_retrieval',
  'collection_data_retrieval',
  'ai_reasoning_completion',
]);

// The tool ids backing the research specialist's wired tasks
// (agent/core/specialistCapabilityRegistry.js's RESEARCH_TASKS), plus
// keyword_research - SEO-owned but research-shaped.
const RESEARCH_TOOL_IDS = new Set([
  'market_research',
  'competitor_research',
  'customer_research',
  'keyword_research',
]);

function getMaxToolCallsPerRun() {
  const envOverride = Number(process.env.MAX_TOOL_CALLS_PER_RUN);
  return envOverride > 0 ? envOverride : 50;
}

function getMaxModelCallsPerRun() {
  const envOverride = Number(process.env.MAX_MODEL_CALLS_PER_RUN);
  return envOverride > 0 ? envOverride : 10;
}

function getMaxResearchCallsPerRun() {
  const envOverride = Number(process.env.MAX_RESEARCH_CALLS_PER_RUN);
  return envOverride > 0 ? envOverride : 15;
}

function getMaxExternalApiCallsPerRun() {
  const envOverride = Number(process.env.MAX_EXTERNAL_API_CALLS_PER_RUN);
  return envOverride > 0 ? envOverride : 15;
}

// A plain caller-held accumulator, same per-run pattern as runTokenTracker/
// runApprovalTracker/runToolResultCache in agent/core/orchestratorExecutionContract.js -
// never module-level state.
function createUsageTracker() {
  return { toolCalls: 0, modelCalls: 0, researchCalls: 0, externalApiCalls: 0 };
}

// Pure read - never mutates usageTracker. Checked before a real dispatch is made;
// the generic tool-call ceiling applies to every toolId, and the model/external/
// research ceilings apply only when toolId is classified into that category.
function checkUsageLimits(toolId, usageTracker) {
  const maxToolCalls = getMaxToolCallsPerRun();
  if (usageTracker.toolCalls >= maxToolCalls) {
    return {
      allowed: false,
      limitType: 'tool_calls',
      reason: `This run has already made ${usageTracker.toolCalls} tool calls, at or beyond its budget of ${maxToolCalls} allowed per run - no further tool calls are allowed this run.`,
    };
  }

  if (MODEL_CALL_TOOL_IDS.has(toolId)) {
    const maxModelCalls = getMaxModelCallsPerRun();
    if (usageTracker.modelCalls >= maxModelCalls) {
      return {
        allowed: false,
        limitType: 'model_calls',
        reason: `This run has already made ${usageTracker.modelCalls} model calls, at or beyond its budget of ${maxModelCalls} allowed per run - no further model calls are allowed this run.`,
      };
    }
  }

  if (EXTERNAL_API_TOOL_IDS.has(toolId)) {
    const maxExternalApiCalls = getMaxExternalApiCallsPerRun();
    if (usageTracker.externalApiCalls >= maxExternalApiCalls) {
      return {
        allowed: false,
        limitType: 'external_api_calls',
        reason: `This run has already made ${usageTracker.externalApiCalls} external API calls, at or beyond its budget of ${maxExternalApiCalls} allowed per run - no further external API calls are allowed this run.`,
      };
    }
  }

  if (RESEARCH_TOOL_IDS.has(toolId)) {
    const maxResearchCalls = getMaxResearchCallsPerRun();
    if (usageTracker.researchCalls >= maxResearchCalls) {
      return {
        allowed: false,
        limitType: 'research_calls',
        reason: `This run has already made ${usageTracker.researchCalls} research calls, at or beyond its budget of ${maxResearchCalls} allowed per run - no further research calls are allowed this run.`,
      };
    }
  }

  return { allowed: true, limitType: null, reason: null };
}

// Called only after checkUsageLimits has allowed the call and only on the real
// (cache-miss) dispatch path - a cache hit never reaches this.
function recordUsage(toolId, usageTracker) {
  usageTracker.toolCalls += 1;
  if (MODEL_CALL_TOOL_IDS.has(toolId)) usageTracker.modelCalls += 1;
  if (EXTERNAL_API_TOOL_IDS.has(toolId)) usageTracker.externalApiCalls += 1;
  if (RESEARCH_TOOL_IDS.has(toolId)) usageTracker.researchCalls += 1;
}

module.exports = {
  MODEL_CALL_TOOL_IDS,
  EXTERNAL_API_TOOL_IDS,
  RESEARCH_TOOL_IDS,
  getMaxToolCallsPerRun,
  getMaxModelCallsPerRun,
  getMaxResearchCallsPerRun,
  getMaxExternalApiCallsPerRun,
  createUsageTracker,
  checkUsageLimits,
  recordUsage,
};
