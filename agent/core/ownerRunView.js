'use strict';

// THE OWNER'S VIEW OF A RUN - what the dashboard shows a non-technical owner about what the
// Chief did, what is waiting for them, and what actually changed.
//
// IT DERIVES, IT NEVER DECIDES. Every field below is read from what the Chief
// (agent/core/orchestratorExecutionContract.js), the approval system (approvals/) and the
// verification layer (reliability/executionVerification.js, via
// integrations/approvedCorrectionDispatch.js) actually recorded. It grants nothing, runs
// nothing and cannot turn a failure into a success: a status of 'success' is only ever
// reported when every plan step completed, the Chief's own result validation passed, nothing
// is still waiting for a decision, and every executed store change was independently verified.
//
// ALLOW-LISTED OUTPUT. Only the fields named here leave this module - never a raw execution
// request, audit detail, policy trace or credential - so a response built from it is safe to
// send to the browser.

const { getToolById } = require('../../tools/toolRegistry');
const { summarizeExecutionState } = require('./resultSummary');
// The single source of truth for which tools change real store data - the same list
// agent/core/mutationIntent.js re-exports. A store change is only ever one of these.
const { isCorrectionTool } = require('../../integrations/approvedCorrectionDispatch');

const OWNER_STATUSES = [
  'success',
  'partial',
  'waiting_for_approval',
  'rejected',
  'blocked_by_compliance',
  'failed',
  'verification_failed',
  'needs_clarification',
];

const STATUS_TEXT = {
  success: 'Done. The Chief completed this, and every result it relied on was checked.',
  partial: 'Partly done. Some steps did not finish - the details below say which.',
  waiting_for_approval: 'Waiting for your approval. Nothing that changes your store has happened yet.',
  rejected: 'You rejected this action, so it was not carried out.',
  blocked_by_compliance: 'Blocked by the compliance check. It cannot be approved or carried out.',
  failed: 'This did not complete. Nothing is reported as done that was not.',
  verification_failed: 'The action ran, but the store did not confirm the change. Treat it as not done and check the store.',
  needs_clarification: 'The Chief needs more detail before it can decide how to handle this.',
};

const MAX_LIST_ENTRIES = 10;

function str(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

// What each existing store correction changes, described from its OWN stated parameters.
// Nothing is looked up or inferred: a parameter the request does not carry is reported as null.
const ACTION_DESCRIPTIONS = {
  shopify_vendor_correction: (params) => ({
    what_changes: 'Product vendor',
    entity_type: 'product',
    entity_id: str(params.productId),
    proposed_value: str(params.newVendor),
  }),
  shopify_inventory_correction: (params) => ({
    what_changes: 'Inventory quantity',
    entity_type: 'inventory item',
    entity_id: str(params.inventoryItemId),
    proposed_value: Number.isFinite(Number(params.delta)) && params.delta !== null && params.delta !== ''
      ? `Adjust by ${Number(params.delta)}${str(params.locationId) ? ` at location ${params.locationId}` : ''}`
      : null,
  }),
  shopify_collection_membership_update: (params) => ({
    what_changes: 'Collection membership',
    entity_type: 'product',
    entity_id: str(params.productId),
    proposed_value: str(params.collectionId) ? `Add to collection ${params.collectionId}` : null,
  }),
};

// The platform a tool is registered for, when the registry names exactly one. A tool that
// names none (platform-neutral) or several is reported as null rather than guessed.
function platformForTool(toolId) {
  const tool = typeof toolId === 'string' ? getToolById(toolId) : null;
  const platforms = tool && Array.isArray(tool.platforms) ? tool.platforms : [];
  return platforms.length === 1 ? platforms[0] : null;
}

// How much is at stake if this action runs, from its approval classification alone.
function riskFor(classification) {
  if (classification === 'externally_executable') return 'high';
  if (classification === 'approval_required') return 'medium';
  return 'low';
}

// One approval request, described for the owner: what will change, where, to what, and why.
function describeProposedAction(request) {
  if (!isPlainObject(request)) return null;
  const executionRequest = isPlainObject(request.execution_request) ? request.execution_request : {};
  const params = isPlainObject(executionRequest.research_params) ? executionRequest.research_params : {};
  const describe = ACTION_DESCRIPTIONS[request.tool_id];
  const described = describe
    ? describe(params)
    : { what_changes: null, entity_type: null, entity_id: null, proposed_value: null };
  const compliance = isPlainObject(executionRequest.compliance) ? executionRequest.compliance : null;
  const autonomy = isPlainObject(executionRequest.autonomy) ? executionRequest.autonomy : null;

  return {
    approval_id: str(request.id),
    tool_id: str(request.tool_id),
    specialist_id: str(request.specialist_id),
    platform: platformForTool(request.tool_id) || (autonomy ? str(autonomy.platform) : null),
    what_changes: described.what_changes || (str(request.tool_id) ? `Runs '${request.tool_id}'` : null),
    entity_type: described.entity_type,
    entity_id: described.entity_id,
    proposed_value: described.proposed_value,
    reason: str(request.reason),
    compliance_status: compliance ? str(compliance.compliance_status) : null,
    compliance_reasons: compliance ? asArray(compliance.review_reasons).filter((reason) => typeof reason === 'string').slice(0, 5) : [],
    classification: str(request.classification),
    risk: riskFor(request.classification),
    approval_status: str(request.status),
    requested_at: str(request.requested_at),
    decided_at: str(request.decided_at),
    decided_by: str(request.decided_by),
    origin: autonomy && autonomy.origin === 'autonomous_cycle' ? 'autonomous_cycle' : 'chief',
  };
}

// Whether a plan step was stopped by a compliance BLOCK - read from what the step itself
// recorded (the orchestrator's refusal text, or publish authorization's failed check).
function stepBlockedByCompliance(step) {
  if (!isPlainObject(step)) return false;
  if (asArray(step.errors).some((error) => typeof error === 'string' && /compliance returned block/i.test(error))) return true;
  const authorization = isPlainObject(step.outputs) && isPlainObject(step.outputs.authorization) ? step.outputs.authorization : null;
  return Boolean(authorization && authorization.failed_check === 'compliance_not_block');
}

function specialistTitle(step) {
  const selected = isPlainObject(step) ? step.selected_specialist : null;
  if (isPlainObject(selected)) return str(selected.title) || str(selected.id);
  return str(selected);
}

// A step's own plain-language summary: the one the route already attached, or the same
// server-side summariser every route uses - never a sentence composed here.
function stepSummary(step) {
  const attached = str(step.summary);
  if (attached) return attached;
  try {
    return str(summarizeExecutionState(step));
  } catch (err) {
    return str(asArray(step.errors).find((error) => typeof error === 'string'));
  }
}

// Plain-text recommendations a step's own output carries, when it carries any. Only strings
// (or objects naming one) are taken - nothing is composed here.
function recommendationsFrom(step) {
  const outputs = isPlainObject(step) && isPlainObject(step.outputs) ? step.outputs : null;
  if (!outputs) return [];
  const result = isPlainObject(outputs.result) ? outputs.result : {};
  const lists = [outputs.recommendations, result.recommendations, result.next_actions];
  const found = [];
  for (const list of lists) {
    for (const entry of asArray(list)) {
      const text = typeof entry === 'string'
        ? str(entry)
        : isPlainObject(entry) ? str(entry.recommendation) || str(entry.title) || str(entry.action) : null;
      if (text && !found.includes(text)) found.push(text);
    }
  }
  return found;
}

// The approved executions /orchestrate/approve recorded on this run, reduced to what the owner
// needs: which approval, the decision, whether it ran, and what verification found.
// `store_change` is true only for the tools that change real store data - the only executions
// that must carry an independent entity verification before they may read as done.
function readExecutions(result) {
  return asArray(result && result.approval_executions)
    .filter(isPlainObject)
    .map((entry) => ({
      approval_id: str(entry.approval_id),
      tool_id: str(entry.tool_id),
      decision: str(entry.decision),
      execution_status: str(entry.execution_status),
      entity_id: str(entry.entity_id),
      proposed_value: str(entry.proposed_value),
      verification_status: isPlainObject(entry.entity_verification) ? str(entry.entity_verification.status) : null,
      decided_at: str(entry.decided_at),
      store_change: typeof entry.tool_id === 'string' && isCorrectionTool(entry.tool_id),
    }));
}

function deriveChiefStatus({ clarification, blocked, steps, pending, executions, verificationStatus }) {
  if (clarification) return 'needs_clarification';
  if (blocked) return 'blocked_by_compliance';
  const executedStoreChanges = executions.filter((entry) => entry.store_change && entry.decision === 'approved' && entry.execution_status === 'success');
  // A store change that ran but was not independently confirmed is never a success.
  if (executedStoreChanges.some((entry) => entry.verification_status !== 'verified')) return 'verification_failed';
  if (pending.length > 0) return 'waiting_for_approval';
  if (executions.some((entry) => entry.decision === 'approved' && entry.execution_status !== 'success')) return 'failed';
  if (executions.length > 0 && executions.every((entry) => entry.decision === 'rejected')) return 'rejected';
  if (steps.length > 0 && steps.every((step) => step.completion_state === 'complete') && verificationStatus === 'passed') return 'success';
  if (steps.length === 0 || steps.every((step) => step.completion_state === 'failed' || step.completion_state === 'not_started')) return 'failed';
  return 'partial';
}

// The consolidated Chief result, for the owner. `result` is the Chief's routing response (or a
// saved record's `result`); nothing else is required.
function describeChiefResultForOwner({ result, runId = null, objective = null, createdAt = null, channel = null } = {}) {
  const safeResult = isPlainObject(result) ? result : {};
  const routing = isPlainObject(safeResult.routing) ? safeResult.routing : {};
  const plan = asArray(routing.plan).filter(isPlainObject);
  const clarification = routing.status === 'clarification_required';
  const pending = asArray(safeResult.pending_approvals).filter((request) => isPlainObject(request) && request.status === 'pending');
  const executions = readExecutions(safeResult);
  const blocked = plan.some(stepBlockedByCompliance);

  const status = deriveChiefStatus({
    clarification,
    blocked,
    steps: plan,
    pending,
    executions,
    verificationStatus: safeResult.verification_status,
  });

  const specialistsUsed = [];
  for (const step of plan) {
    const title = specialistTitle(step);
    if (title && !specialistsUsed.includes(title)) specialistsUsed.push(title);
  }

  const toolPlatforms = [];
  for (const step of plan) {
    const platform = platformForTool(isPlainObject(step.inputs) ? step.inputs.tool_id : null);
    if (platform && !toolPlatforms.includes(platform)) toolPlatforms.push(platform);
  }

  const recommendations = [];
  for (const step of plan) {
    for (const text of recommendationsFrom(step)) {
      if (!recommendations.includes(text)) recommendations.push(text);
    }
  }

  const executed = executions.filter((entry) => entry.decision === 'approved' && entry.execution_status === 'success');
  const executedStoreChanges = executed.filter((entry) => entry.store_change);
  const lastExecution = executions.length > 0 ? executions[executions.length - 1] : null;

  let executionState;
  if (executed.length > 0) executionState = 'executed';
  else if (pending.length > 0) executionState = 'waiting_for_approval';
  else if (lastExecution) executionState = 'not_executed';
  else if (plan.length > 0 && plan.every((step) => step.completion_state === 'complete')) executionState = 'completed';
  else executionState = 'not_completed';

  let verificationState;
  if (executedStoreChanges.length > 0) {
    const unconfirmed = executedStoreChanges.find((entry) => entry.verification_status !== 'verified');
    verificationState = unconfirmed ? unconfirmed.verification_status || 'not_verified' : 'verified';
  } else if (safeResult.verification_status === 'passed') {
    verificationState = 'passed';
  } else if (safeResult.verification_status === 'failed') {
    verificationState = 'failed';
  } else {
    verificationState = 'not_verified';
  }

  const complianceStatuses = [];
  for (const request of [...pending, ...asArray(safeResult.pending_approvals).filter((request) => isPlainObject(request) && request.status !== 'pending')]) {
    const described = describeProposedAction(request);
    if (described && described.compliance_status && !complianceStatuses.includes(described.compliance_status)) {
      complianceStatuses.push(described.compliance_status);
    }
  }
  if (blocked && !complianceStatuses.includes('BLOCK')) complianceStatuses.push('BLOCK');

  const proposedActions = pending.map(describeProposedAction).filter(Boolean);
  const risk = proposedActions.some((action) => action.risk === 'high') || executedStoreChanges.length > 0
    ? 'high'
    : proposedActions.some((action) => action.risk === 'medium') ? 'medium' : 'low';

  return {
    run_id: str(runId),
    objective: str(objective) || str(safeResult.objective),
    created_at: str(createdAt),
    status,
    status_text: STATUS_TEXT[status],
    specialists_used: specialistsUsed,
    platform: str(channel) || (toolPlatforms.length === 1 ? toolPlatforms[0] : null),
    findings: plan
      .map((step) => ({
        specialist: specialistTitle(step),
        state: str(step.completion_state),
        summary: stepSummary(step),
      }))
      .filter((finding) => finding.summary)
      .slice(0, MAX_LIST_ENTRIES),
    recommendations: recommendations.slice(0, MAX_LIST_ENTRIES),
    proposed_actions: proposedActions,
    risk,
    compliance: complianceStatuses,
    approval_state: pending.length > 0 ? 'pending' : lastExecution ? lastExecution.decision || 'decided' : 'not_needed',
    execution_state: executionState,
    verification_state: verificationState,
    // Only real store changes: the correction tools, approved and executed.
    mutations: executedStoreChanges.map((entry) => ({
      approval_id: entry.approval_id,
      tool_id: entry.tool_id,
      entity_id: entry.entity_id,
      proposed_value: entry.proposed_value,
      verification_status: entry.verification_status,
      decided_at: entry.decided_at,
    })),
    clarification: clarification ? str(routing.reason) : null,
  };
}

// A saved run record, reduced to one History row for the owner. Handles every run kind the
// run store holds; an unrecognised kind is described only by its own saved status.
function describeRunRecordForOwner(record) {
  if (!isPlainObject(record)) return null;
  const result = isPlainObject(record.result) ? record.result : {};

  if (record.kind === 'orchestrate') {
    const view = describeChiefResultForOwner({
      result,
      runId: record.run_id,
      objective: record.objective,
      createdAt: record.created_at,
      channel: record.channel,
    });
    return {
      status: view.status,
      status_text: view.status_text,
      agent: view.specialists_used.length > 0 ? `Chief → ${view.specialists_used.join(', ')}` : 'Chief',
      platform: view.platform,
      approval_state: view.approval_state,
      execution_state: view.execution_state,
      verification_state: view.verification_state,
      mutation_count: view.mutations.length,
    };
  }

  if (record.kind === 'autonomous_cycle') {
    const steps = asArray(result.steps).filter(isPlainObject);
    const executed = steps.filter((step) => step.outcome === 'executed');
    const status = record.status === 'success' ? 'success' : record.status === 'error' ? 'failed' : 'partial';
    return {
      status,
      status_text: STATUS_TEXT[status],
      agent: 'Autonomous cycle',
      platform: null,
      approval_state: steps.some((step) => step.outcome === 'approval_required') ? 'pending' : 'not_needed',
      execution_state: executed.length > 0 ? 'executed' : steps.some((step) => step.outcome === 'observed') ? 'observed' : 'not_completed',
      verification_state: executed.length > 0 && executed.every((step) => step.verification === 'verified')
        ? 'verified'
        : executed.length > 0 ? 'not_verified' : 'not_applicable',
      mutation_count: executed.length,
    };
  }

  const status = record.status === 'success'
    ? 'success'
    : record.status === 'error' || record.status === 'failed'
      ? 'failed'
      : record.status === 'needs_clarification' ? 'needs_clarification' : 'partial';
  const toolId = isPlainObject(result.inputs) ? result.inputs.tool_id : null;
  return {
    status,
    status_text: STATUS_TEXT[status],
    agent: str(record.specialist_name) || str(record.specialist_id) || str(record.kind) || 'Run',
    platform: str(record.channel) || platformForTool(toolId),
    approval_state: asArray(result.approvals).some((approval) => isPlainObject(approval) && approval.status === 'required') ? 'pending' : 'not_needed',
    execution_state: result.completion_state === 'complete' ? 'completed' : 'not_completed',
    verification_state: result.completion_state === 'complete' ? 'passed' : 'not_verified',
    mutation_count: 0,
  };
}

module.exports = {
  OWNER_STATUSES,
  STATUS_TEXT,
  riskFor,
  platformForTool,
  describeProposedAction,
  describeChiefResultForOwner,
  describeRunRecordForOwner,
};
