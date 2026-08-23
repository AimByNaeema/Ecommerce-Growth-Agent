'use strict';

// The Chief/Orchestrator's execution contract: a real, callable implementation of
// agent/core/agentContract.js's lifecycle stages - receive -> normalize -> identify
// capability -> detect missing info -> build execution request -> select specialist
// -> pass minimum context -> receive specialist result -> validate -> respond.
//
// Deterministic only - no AI/Claude API call is made here. agentContract.js's own
// header reserves "no AI API calls" for a later, explicitly-scoped prompt, so
// capability identification is plain keyword matching against the existing
// tools/toolRegistry.js entries.
//
// No autonomous or write-capable external action - the only real tool call available
// today is the existing read-only tools/businessConfigurationRetrieval.js, and it only
// runs when its approval classification allows it to proceed automatically (see
// approvals/approvalArchitecture.js). Anything approval_required/externally_executable
// stops and reports that instead of executing.
//
// No new persistence - the returned state is a stateModel.js-shaped object built
// in-memory and returned to the caller; it is never written to memory/state/ (no
// storage mechanism has been chosen yet).

const { TOOL_REGISTRY, getToolById } = require('../../tools/toolRegistry');
const { getSpecialistById } = require('./specialistRegistry');
const { getContextBoundaries } = require('./contextBoundaries');
const { getClassificationById } = require('../../approvals/approvalArchitecture');
const { createEmptyState } = require('./stateModel');
const businessConfigurationRetrieval = require('../../tools/businessConfigurationRetrieval');

// Categories in tools/toolRegistry.js that belong to a specialist agent, per
// CLAUDE.md section 2's 7 approved specialists. Categories not listed here
// (configuration, memory, verification) are Orchestrator/shared infrastructure,
// handled directly rather than delegated (CLAUDE.md section 3). 'listing' and
// 'social_advertising' have no category in TOOL_REGISTRY today, so a task needing
// them cannot be matched to an existing tool - it correctly falls through to
// "no capability available" rather than being invented here.
const CATEGORY_TO_SPECIALIST = {
  products: 'product',
  research: 'research',
  customer_market_intelligence: 'research',
  seo: 'seo',
  marketing: 'marketing',
  analytics: 'analytics_optimization',
};

// Tool ids this orchestrator knows how to actually call. Each entry maps a
// TOOL_REGISTRY id to the real function that performs the work - the only sanctioned
// way execution happens, never a generic/dynamic call.
const TOOL_EXECUTORS = {
  business_configuration_retrieval: () =>
    businessConfigurationRetrieval.retrieveBusinessConfiguration(),
};

// The one real tool implemented today is a read-only GET against Shopify (no writes,
// no side effects) - classified analysis_only for approval purposes, distinct from a
// future write-capable tool that would need approval_required/externally_executable.
const TOOL_CLASSIFICATIONS = {
  business_configuration_retrieval: 'analysis_only',
};

// Approval classifications that may proceed automatically. Anything else
// (approval_required, externally_executable) must stop and surface an approval
// requirement rather than execute - see approvals/approvalArchitecture.js.
const AUTO_APPROVED_CLASSIFICATIONS = ['analysis_only', 'recommendation'];

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

// Create a structured execution request from the identified capability.
function createExecutionRequest(objective, capability) {
  const category = capability.category;
  const specialistId = CATEGORY_TO_SPECIALIST[category] || null;
  return {
    objective,
    category,
    tool_id: capability.tool.id,
    specialist_id: specialistId,
    is_shared_infrastructure: specialistId === null,
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

// Receive the specialist result - the real dispatch point. Never fabricates a result:
// an unimplemented tool or a missing approval both return an explicit, honest outcome
// instead of executing or guessing.
async function executeSelectedCapability(executionRequest) {
  const tool = getToolById(executionRequest.tool_id);

  if (!tool) {
    return { status: 'error', data: null, error: `Unknown tool: ${executionRequest.tool_id}`, classification: null };
  }

  if (tool.status !== 'implemented') {
    return {
      status: 'not_available',
      data: null,
      error: `Capability '${tool.id}' is registered but not yet implemented.`,
      classification: null,
    };
  }

  const classification = TOOL_CLASSIFICATIONS[tool.id] || null;
  if (!classification || !AUTO_APPROVED_CLASSIFICATIONS.includes(classification)) {
    const classificationInfo = classification ? getClassificationById(classification) : null;
    return {
      status: 'approval_required',
      data: null,
      error: `Executing '${tool.id}' requires explicit approval before it can proceed.`,
      classification: classificationInfo ? classificationInfo.id : classification,
    };
  }

  const executor = TOOL_EXECUTORS[tool.id];
  if (!executor) {
    return {
      status: 'error',
      data: null,
      error: `No executor is wired for implemented tool '${tool.id}'.`,
      classification,
    };
  }

  try {
    const data = await executor();
    return { status: 'success', data, error: null, classification };
  } catch (err) {
    return { status: 'error', data: null, error: err.message, classification };
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

// Return the final structured response - assembles state (in-memory only, never
// persisted, see module header) plus every field the caller needs.
function buildFinalResponse({ objective, infoCheck, capability, executionRequest, specialist, outcome, verificationStatus }) {
  const state = createEmptyState(objective || '');
  if (infoCheck.needs_more_information) {
    state.task_status = 'blocked';
  } else if (verificationStatus === 'passed') {
    state.task_status = 'complete';
  } else if (verificationStatus === 'failed') {
    state.task_status = 'failed';
  } else {
    state.task_status = 'in_progress';
  }
  state.verification_status = verificationStatus === 'passed' || verificationStatus === 'failed'
    ? verificationStatus
    : 'unverified';
  if (outcome && outcome.error) {
    state.failed_work = [outcome.error];
  }

  return {
    objective: objective || null,
    needs_more_information: infoCheck.needs_more_information,
    clarification_reason: infoCheck.reason,
    capability: capability ? { category: capability.category, tool_id: capability.tool.id } : null,
    execution_request: executionRequest,
    specialist,
    outcome,
    verification_status: verificationStatus,
    state,
  };
}

// The single entry point: runs every step in order. Never throws - all failures
// become structured outcomes inside the returned response.
async function runOrchestratorContract(rawTask) {
  let objective;
  try {
    objective = understandObjective(rawTask);
  } catch (err) {
    return buildFinalResponse({
      objective: typeof rawTask === 'string' ? rawTask : null,
      infoCheck: { needs_more_information: true, reason: err.message },
      capability: null,
      executionRequest: null,
      specialist: null,
      outcome: null,
      verificationStatus: 'unverified',
    });
  }

  const capability = identifyRequiredCapability(objective);
  const infoCheck = needsMoreInformation(objective, capability);

  if (infoCheck.needs_more_information) {
    return buildFinalResponse({
      objective,
      infoCheck,
      capability,
      executionRequest: null,
      specialist: null,
      outcome: null,
      verificationStatus: 'unverified',
    });
  }

  const executionRequest = createExecutionRequest(objective, capability);
  const specialist = selectSpecialist(executionRequest);
  // Computed for completeness/traceability - no retrieval step consumes it yet
  // (retrieve_context is still conceptual, per agent/core/agentContract.js).
  gatherMinimumContext(executionRequest);

  const outcome = await executeSelectedCapability(executionRequest);
  const verificationStatus = validateResult(outcome);

  return buildFinalResponse({
    objective,
    infoCheck,
    capability,
    executionRequest,
    specialist,
    outcome,
    verificationStatus,
  });
}

module.exports = {
  CATEGORY_TO_SPECIALIST,
  understandObjective,
  identifyRequiredCapability,
  needsMoreInformation,
  createExecutionRequest,
  selectSpecialist,
  gatherMinimumContext,
  executeSelectedCapability,
  validateResult,
  buildFinalResponse,
  runOrchestratorContract,
};

if (require.main === module) {
  const sampleTasks = [
    '',
    'find me trending products to sell',
    "check my shop's business configuration",
  ];

  (async () => {
    console.log('Smart E-Commerce Growth AI Agent - orchestrator execution contract:\n');
    for (const task of sampleTasks) {
      console.log(`--- Task: ${JSON.stringify(task)} ---`);
      const response = await runOrchestratorContract(task);
      console.log(JSON.stringify(response, null, 2));
      console.log('');
    }
  })();
}
