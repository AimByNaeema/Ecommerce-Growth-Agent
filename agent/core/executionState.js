'use strict';

// The shared execution state passed to/from one specialist dispatch, by the
// Chief/Orchestrator (see agent/core/orchestratorExecutionContract.js). This is
// deliberately NOT the same thing as agent/core/stateModel.js - that file is the
// compact shape of one *persisted* task's state (meant for memory/state/, once
// persistence is implemented); this one is transient, built fresh for every routed
// specialist, and exists so unnecessary information never leaks from one specialist's
// step into another's (each state is self-contained: it never carries another step's
// outputs/evidence/tool_calls).
//
// A schema and a couple of pure helpers only - no execution, no I/O, no tool
// dispatch. orchestratorExecutionContract.js does the real dispatch and calls
// deriveExecutionState() with what it already computed, so the confidence/
// completion_state/approvals derivation rules live in exactly one place.

const { CONFIDENCE_LEVELS } = require('./researchRecordModel');
const { TASK_STATUSES } = require('./stateModel');

const EXECUTION_STATE_FIELDS = [
  {
    id: 'request',
    title: 'Request',
    type: 'string',
    description: "The original objective this state belongs to, once - not repeated per field.",
  },
  {
    id: 'current_task',
    title: 'Current task',
    type: 'string',
    description: 'The specific piece of the request this specialist is handling - a clause, not the whole plan.',
  },
  {
    id: 'selected_specialist',
    title: 'Selected specialist',
    type: 'object | null',
    description: 'Identity only ({ type, id, title }) - not the full specialist registry entry.',
  },
  {
    id: 'inputs',
    title: 'Inputs',
    type: 'object | null',
    description:
      'What was actually asked for ({ category, tool_id, capability_id, input_contract }) - not a duplicate of the full execution request. capability_id/input_contract are looked up from agent/core/specialistCapabilityRegistry.js\'s supported_tasks that reference the matched tool - when more than one task shares that tool, the one whose own wording best matches the request wins (same scoring used for tool selection), ties broken by declared order; both stay null only when zero tasks reference the matched tool, or no tool was matched at all.',
  },
  {
    id: 'required_context',
    title: 'Required context',
    type: 'array',
    description: 'Context boundary ids only (see agent/core/contextBoundaries.js) - not the full boundary descriptions.',
  },
  {
    id: 'outputs',
    title: 'Outputs',
    type: 'any | null',
    description: "The specialist/tool's real result data - no wrapper, never fabricated if nothing was produced.",
  },
  {
    id: 'evidence',
    title: 'Evidence',
    type: 'array',
    description: 'Compact references ({ tool_id, status }) backing the outputs - only present when there is a real output.',
  },
  {
    id: 'confidence',
    title: 'Confidence',
    type: `enum: ${CONFIDENCE_LEVELS.join(' | ')}`,
    description: 'Reuses researchRecordModel.js\'s confidence levels - mechanically derived from verification, never invented.',
  },
  {
    id: 'tool_calls',
    title: 'Tool calls',
    type: 'array',
    description: 'Ids of tools actually invoked for this step - empty if none were.',
  },
  {
    id: 'approvals',
    title: 'Approvals',
    type: 'array',
    description: 'Entries of { classification, status } where status is "required" or "auto_approved" - "required" entries also carry an approval_request_id (see approvals/approvalWorkflow.js) - empty when no classification applies.',
  },
  {
    id: 'errors',
    title: 'Errors',
    type: 'array',
    description: 'Error messages for this step only - empty unless something actually failed.',
  },
  {
    id: 'completion_state',
    title: 'Completion state',
    type: `enum: ${TASK_STATUSES.join(' | ')}`,
    description: "Reuses stateModel.js's TASK_STATUSES - derived mechanically from the step's outcome.",
  },
];

const ARRAY_FIELD_IDS = EXECUTION_STATE_FIELDS.filter((field) => field.type === 'array').map(
  (field) => field.id
);

// Most tools (see tools/marketProductOpportunityTool.js, tools/analyticsDataTool.js,
// and 16 others - business_configuration_retrieval and ai_reasoning_completion are the
// only exceptions, they throw instead) return their own honest
// { status, result, error } outcome rather than throwing - distinct from whether the
// executor call itself threw (agent/core/orchestratorExecutionContract.js's
// runExecutor wraps either case as outer outcome.status 'success'/'error'). Recognizes
// that convention wherever it shows up (outcome.data, which becomes this state's own
// .outputs) so a tool-level 'failed'/'empty' result is never read as a real success
// just because the call didn't throw. Returns null for tools that don't follow the
// convention - their outer outcome.status is the only signal there is.
const TOOL_RESULT_STATUSES = ['success', 'failed', 'empty', 'partial'];
function getToolResultStatus(data) {
  if (
    data &&
    typeof data === 'object' &&
    typeof data.status === 'string' &&
    TOOL_RESULT_STATUSES.includes(data.status) &&
    'result' in data
  ) {
    return data.status;
  }
  return null;
}

// Returns a blank execution state conforming to EXECUTION_STATE_FIELDS. No specialist
// has been dispatched yet - callers fill it in via deriveExecutionState().
function createEmptyExecutionState(request = '') {
  return {
    request,
    current_task: '',
    selected_specialist: null,
    inputs: null,
    required_context: [],
    outputs: null,
    evidence: [],
    confidence: 'unassessed',
    tool_calls: [],
    approvals: [],
    errors: [],
    completion_state: 'not_started',
  };
}

// Mechanically derives one populated execution state from the pieces the caller
// already computed - never guesses, never adds fields beyond the 12 above. Confidence
// is only ever 'high' when the outcome actually passed verification with real data;
// otherwise 'unassessed' (an error or an unavailable capability is not a low-confidence
// finding, it is no finding at all).
function deriveExecutionState({
  request,
  currentTask,
  target,
  category = null,
  toolId = null,
  capabilityId = null,
  inputContract = null,
  requiredContextIds = [],
  outcome = null,
  verificationStatus = 'unverified',
  approvalRequestId = null,
}) {
  const state = createEmptyExecutionState(request);
  state.current_task = currentTask || request;
  state.selected_specialist = target ? { type: target.type, id: target.id, title: target.title } : null;
  state.inputs = toolId
    ? { category, tool_id: toolId, capability_id: capabilityId, input_contract: inputContract }
    : null;
  state.required_context = requiredContextIds;
  state.tool_calls = toolId ? [toolId] : [];

  if (outcome) {
    state.outputs = outcome.data || null;
    // Evidence is keyed off verificationStatus (already the single source of truth
    // for "was this actually usable"), never off the outer outcome.status alone - a
    // tool-level failure/empty result must never be recorded as successful evidence
    // just because the call itself didn't throw.
    state.evidence = verificationStatus === 'passed' && outcome.data
      ? [{ tool_id: toolId, status: outcome.status }]
      : [];
    // Prefer the outer error; when absent, surface the tool's own honest inner error
    // (see getToolResultStatus) instead of silently reporting no error at all for a
    // step that did in fact fail/come back empty.
    const innerError =
      getToolResultStatus(outcome.data) && typeof outcome.data.error === 'string' ? outcome.data.error : null;
    state.errors = outcome.error ? [outcome.error] : innerError ? [innerError] : [];

    if (outcome.status === 'approval_required') {
      state.approvals = [{ classification: outcome.classification, status: 'required', approval_request_id: approvalRequestId }];
    } else if (outcome.classification) {
      state.approvals = [{ classification: outcome.classification, status: 'auto_approved' }];
    }
  }

  // A successful call only earns 'high' confidence when it retrieved/verified real
  // data (e.g. analysis_only). A 'recommendation' outcome (e.g. a Claude-drafted
  // suggestion) succeeded as an API call, but the content itself is generated, not
  // independently verified - CONFIDENCE_LEVELS' 'unassessed' is the honest label
  // until something actually reviews it (see approvals/approvalArchitecture.js's own
  // description of 'recommendation').
  const isUnverifiedRecommendation = outcome && outcome.classification === 'recommendation';
  state.confidence = verificationStatus === 'passed' && !isUnverifiedRecommendation ? 'high' : 'unassessed';

  if (verificationStatus === 'passed') {
    state.completion_state = 'complete';
  } else if (verificationStatus === 'failed') {
    state.completion_state = 'failed';
  } else if (outcome) {
    state.completion_state = 'blocked';
  } else {
    state.completion_state = 'not_started';
  }

  return state;
}

// Checks that an execution state has exactly the expected keys, with the expected
// basic shapes. Does not guess or fill in anything missing - only reports.
function validateExecutionStateShape(state) {
  const errors = [];

  if (typeof state !== 'object' || state === null || Array.isArray(state)) {
    return { valid: false, errors: ['state must be a plain object'] };
  }

  const expectedIds = EXECUTION_STATE_FIELDS.map((field) => field.id);
  const actualIds = Object.keys(state);

  for (const id of expectedIds) {
    if (!actualIds.includes(id)) {
      errors.push(`missing field: ${id}`);
    }
  }
  for (const id of actualIds) {
    if (!expectedIds.includes(id)) {
      errors.push(`unexpected field: ${id}`);
    }
  }

  for (const id of ARRAY_FIELD_IDS) {
    if (id in state && !Array.isArray(state[id])) {
      errors.push(`${id} must be an array`);
    }
  }

  if ('confidence' in state && !CONFIDENCE_LEVELS.includes(state.confidence)) {
    errors.push(`confidence must be one of: ${CONFIDENCE_LEVELS.join(', ')}`);
  }
  if ('completion_state' in state && !TASK_STATUSES.includes(state.completion_state)) {
    errors.push(`completion_state must be one of: ${TASK_STATUSES.join(', ')}`);
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  EXECUTION_STATE_FIELDS,
  createEmptyExecutionState,
  deriveExecutionState,
  validateExecutionStateShape,
  getToolResultStatus,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - shared execution state (schema only):\n');
  EXECUTION_STATE_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty state:');
  console.log(JSON.stringify(createEmptyExecutionState('(no request set)'), null, 2));
}
