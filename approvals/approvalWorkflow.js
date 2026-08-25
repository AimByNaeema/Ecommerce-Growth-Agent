'use strict';

// The Approval Workflow. Turns approvals/approvalArchitecture.js's classification +
// policy data into a real pending -> approved/rejected lifecycle for one Approval
// Request (approvals/approvalRequestModel.js).
//
// Standalone deliverable, following the same deliberate scope choice
// agent/core/experimentLearningStore.js already made: there is no database or
// file-persistence layer here (agent/core/memory/ has no persistence engine
// implemented yet, and adding one is an unscoped technical decision per CLAUDE.md rule
// 15) - like every other engine in this project, this module is a set of pure
// functions over a caller-held array of request records. Whoever calls it (the Chief -
// see agent/core/orchestratorExecutionContract.js's executeSelectedCapability()/
// resumeApprovedExecution() - or a human reviewing pending requests) is responsible for
// keeping that array across calls; this module never holds hidden state.
//
// IDS ARE ALWAYS CALLER-SUPPLIED: nothing here uses crypto/uuid/an internal counter,
// matching every other record in this project (e.g. agent/core/experimentModel.js's
// experiment_id) - deterministic and reproducible, never random.
//
// NEVER SILENTLY PERFORMED: decideApprovalRequest() is the only function that can move
// a request out of 'pending', and it requires a non-empty `decidedBy` - there is no
// path anywhere in this module (or in agent/core/orchestratorExecutionContract.js's
// resumeApprovedExecution()) that executes a gated action without a real, accountable
// decision having been recorded first. See CLAUDE.md rule 7 and
// approvals/approvalArchitecture.js's 'never_silent_consequential_action' policy rule.
//
// IMMUTABLE: decideApprovalRequest() never mutates the array it is given - it returns
// a new array with the matching record replaced, the same caller-holds-the-array
// discipline agent/core/experimentLearningStore.js already established.

const { getClassificationById } = require('./approvalArchitecture');
const {
  APPROVAL_REQUEST_STATUSES,
  createEmptyApprovalRequest,
  validateApprovalRequestShape,
} = require('./approvalRequestModel');

function requireNonEmptyString(value, fieldName, fnName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fnName} requires a non-empty \`${fieldName}\` string.`);
  }
}

// ---------------------------------------------------------------------------------
// createApprovalRequest
// ---------------------------------------------------------------------------------

function createApprovalRequest({ id, classification, specialistId = null, toolId, executionRequest, reason } = {}) {
  const fnName = 'createApprovalRequest';

  requireNonEmptyString(id, 'id', fnName);
  requireNonEmptyString(toolId, 'toolId', fnName);
  requireNonEmptyString(reason, 'reason', fnName);

  if (!getClassificationById(classification)) {
    throw new Error(
      `${fnName} requires \`classification\` to be one of approvals/approvalArchitecture.js's real classification ids, got '${classification}'.`
    );
  }
  if (!executionRequest || typeof executionRequest !== 'object' || Array.isArray(executionRequest)) {
    throw new Error(`${fnName} requires an \`executionRequest\` object to resume later.`);
  }
  if (specialistId !== null && typeof specialistId !== 'string') {
    throw new Error(`${fnName} requires \`specialistId\` to be a string or null.`);
  }

  const record = createEmptyApprovalRequest(id);
  record.classification = classification;
  record.specialist_id = specialistId;
  record.tool_id = toolId;
  record.execution_request = executionRequest;
  record.reason = reason;
  record.status = 'pending';
  record.requested_at = new Date().toISOString();

  const validation = validateApprovalRequestShape(record);
  if (!validation.valid) {
    throw new Error(`Composed Approval Request failed validation: ${validation.errors.join('; ')}`);
  }
  return record;
}

// ---------------------------------------------------------------------------------
// decideApprovalRequest - the only function that can move a request out of 'pending'.
// ---------------------------------------------------------------------------------

function requireRequestArray(requests, fnName) {
  if (!Array.isArray(requests)) {
    throw new Error(`${fnName} requires \`requests\` to be an array.`);
  }
}

const DECIDABLE_STATUSES = ['approved', 'rejected'];

function decideApprovalRequest(requests, requestId, { decision, decidedBy, notes = null } = {}) {
  const fnName = 'decideApprovalRequest';

  requireRequestArray(requests, fnName);
  requireNonEmptyString(requestId, 'requestId', fnName);
  requireNonEmptyString(decidedBy, 'decidedBy', fnName);

  if (!DECIDABLE_STATUSES.includes(decision)) {
    throw new Error(`${fnName} requires \`decision\` to be one of: ${DECIDABLE_STATUSES.join(', ')}`);
  }

  const index = requests.findIndex((request) => request.id === requestId);
  if (index === -1) {
    throw new Error(`${fnName} found no request with id '${requestId}'.`);
  }

  const existing = requests[index];
  if (existing.status !== 'pending') {
    throw new Error(
      `${fnName} cannot decide request '${requestId}' - it is already '${existing.status}', not 'pending'.`
    );
  }

  const decided = {
    ...existing,
    status: decision,
    decided_at: new Date().toISOString(),
    decided_by: decidedBy,
    decision_notes: notes,
  };

  const validation = validateApprovalRequestShape(decided);
  if (!validation.valid) {
    throw new Error(`Decided Approval Request failed validation: ${validation.errors.join('; ')}`);
  }

  const updated = requests.slice();
  updated[index] = decided;
  return updated;
}

// ---------------------------------------------------------------------------------
// Read helpers - pure, no mutation.
// ---------------------------------------------------------------------------------

function getApprovalRequestById(requests, id) {
  requireRequestArray(requests, 'getApprovalRequestById');
  return requests.find((request) => request.id === id);
}

function getPendingApprovalRequests(requests) {
  requireRequestArray(requests, 'getPendingApprovalRequests');
  return requests.filter((request) => request.status === 'pending');
}

function isApprovalGranted(requests, id) {
  const request = getApprovalRequestById(requests, id);
  return Boolean(request && request.status === 'approved');
}

module.exports = {
  APPROVAL_REQUEST_STATUSES,
  createApprovalRequest,
  decideApprovalRequest,
  getApprovalRequestById,
  getPendingApprovalRequests,
  isApprovalGranted,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Approval Workflow (pure lifecycle over a caller-held array):\n');

  const pendingRequest = createApprovalRequest({
    id: 'apr-1',
    classification: 'externally_executable',
    specialistId: 'seo',
    toolId: 'hypothetical_publish_listing',
    executionRequest: { objective: 'publish updated title', tool_id: 'hypothetical_publish_listing' },
    reason: "Executing 'hypothetical_publish_listing' requires explicit approval before it can proceed.",
  });
  console.log('A new pending request:');
  console.log(JSON.stringify(pendingRequest, null, 2));

  const decided = decideApprovalRequest([pendingRequest], 'apr-1', {
    decision: 'approved',
    decidedBy: 'store-owner@example.com (caller-supplied placeholder)',
    notes: 'Reviewed the new title manually before approving.',
  });
  console.log('\nAfter a real, accountable decision:');
  console.log(JSON.stringify(decided[0], null, 2));

  console.log('\nisApprovalGranted:', isApprovalGranted(decided, 'apr-1'));
  console.log('getPendingApprovalRequests (should be empty now):', JSON.stringify(getPendingApprovalRequests(decided)));
  console.log('\nThe original array passed to decideApprovalRequest is never mutated - a new array is always returned.');
}
