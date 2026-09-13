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

const { getClassificationById, verifyApprovalAuthorization } = require('./approvalArchitecture');
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

// expectedBusinessId (optional, additive): a defense-in-depth cross-business isolation
// guard (CLAUDE.md section 1's multi-business goal). Business identity rides inside
// execution_request.business_id (set by agent/core/orchestratorExecutionContract.js's
// createExecutionRequest) - not a approvalRequestModel.js schema field, so no change
// was needed there. When supplied, a request belonging to a different business is
// refused before any mutation happens, exactly like every other precondition check
// below. Omitting it preserves today's exact behavior (no cross-business check).
// `authorization` is REQUIRED and is the only thing that can make a decision real: it is
// { nonce, signature }, where the signature is an Ed25519 signature over the challenge this
// server issued for exactly this request, decision and approver (see
// approvals/approvalArchitecture.js's verifyApprovalAuthorization).
//
// WHY decidedBy IS NO LONGER SUFFICIENT ON ITS OWN. It never was evidence - it is a string
// this process can write as easily as a person can, which is exactly how an agent could
// approve its own pending action. It is still required, because a decision must still NAME
// an accountable person, but it is now a label ON the proof rather than the proof itself:
// the signature must have been produced for that same approver, so the name cannot be
// swapped after the fact either.
//
// FAILS CLOSED. Verification is attempted before any mutation, and an unverified decision
// throws - there is no branch anywhere in this function that records a decision without a
// signature that validated under the configured public key.
function decideApprovalRequest(
  requests,
  requestId,
  { decision, decidedBy, notes = null, expectedBusinessId = null, authorization = null } = {}
) {
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

  const actualBusinessId = existing.execution_request && existing.execution_request.business_id;
  if (expectedBusinessId && actualBusinessId !== expectedBusinessId) {
    throw new Error(
      `${fnName} refused: request '${requestId}' belongs to business '${actualBusinessId || '(none)'}', not '${expectedBusinessId}'.`
    );
  }

  // THE HUMAN-PROVENANCE GATE. Last precondition checked, and the one that cannot be
  // satisfied from inside this process: it needs a signature produced with a key this
  // server does not hold. Everything above is a consistency check; this is the proof.
  const verification = verifyApprovalAuthorization({ request: existing, decision, decidedBy, authorization });
  if (!verification.verified) {
    throw new Error(
      `${fnName} refused: the decision on '${requestId}' is not accompanied by verified human authorization ` +
        `(${verification.failed_check}). ${verification.reason}`
    );
  }

  const decided = {
    ...existing,
    status: decision,
    decided_at: new Date().toISOString(),
    decided_by: decidedBy,
    decision_notes: notes,
    // The verified provenance rides INSIDE execution_request, which
    // approvals/approvalRequestModel.js already relays "as-is, never rebuilt" - the same
    // place approvals/complianceApprovalGate.js attaches its compliance summary. The record
    // schema is deliberately not widened for this: a new top-level field would change a
    // shape that publishAuthorization.js and the model validator both depend on.
    execution_request: {
      ...(existing.execution_request && typeof existing.execution_request === 'object' ? existing.execution_request : {}),
      approval_provenance: verification.provenance,
    },
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

// ---------------------------------------------------------------------------------
// DURABLE PENDING STATE - the same lifecycle, surviving a restart.
// ---------------------------------------------------------------------------------
//
// The pure, caller-held-array functions above are UNCHANGED and remain the whole lifecycle:
// createApprovalRequest still makes the pending record, decideApprovalRequest is still the
// only thing that can move one out of pending, and it still demands a verified Ed25519
// signature. The three functions below only add durability around them - they compose, they
// do not replace, and nothing here decides anything.
//
// WHY IT IS ADDITIVE RATHER THAN BUILT IN. A caller that holds its own array keeps working
// exactly as before; a caller that wants its pending approvals to outlive the process opts
// in by using these. That is the same additive convention expectedBusinessId, auditTracker
// and businessId already follow throughout this project.
//
// STORAGE LIVES IN approvals/approvalStore.js, not here: this module's own contract is to
// hold no hidden state, and that stays true - every function below takes or returns the
// state it works on, and the store is the only thing that touches a file.

const approvalStore = require('./approvalStore');

// Creates a pending approval AND persists it, so the decision point survives a restart.
// Returns the record itself (not the storage envelope), so this is a drop-in for
// createApprovalRequest at any call site that wants durability.
function createAndPersistApprovalRequest(options = {}, storeOptions = {}) {
  const record = createApprovalRequest(options);
  approvalStore.saveApprovalRecord(record, storeOptions);
  return record;
}

// Records a decision through the real decideApprovalRequest - signature verification and
// all - and persists the decided record.
//
// THE DECISION IS MADE FIRST, PERSISTED SECOND. An unverified decision throws before
// anything is written, so a refused approval leaves the stored state untouched rather than
// recording an attempt that did not happen.
//
// Returns the same new array decideApprovalRequest returns, so this is a drop-in for it.
function decideAndPersistApprovalRequest(requests, requestId, options = {}, storeOptions = {}) {
  const updated = decideApprovalRequest(requests, requestId, options);
  const decided = getApprovalRequestById(updated, requestId);
  approvalStore.saveApprovalRecord(decided, { ...storeOptions, executionState: 'decided' });
  return updated;
}

// Rebuilds the caller-held array after a restart, from durable state alone.
//
// Returns REAL approval records - the same shape createApprovalRequest produced, carrying
// their original identity, execution request, business_id, and (once decided) the verified
// approval provenance. Every one is re-validated against approvals/approvalRequestModel.js
// before being handed back, so a file that has been edited into an invalid shape is dropped
// rather than trusted: reload is a read of durable state, never an opportunity to introduce
// a record the schema would have refused.
function loadPendingApprovalRequests(storeOptions = {}) {
  return approvalStore
    .listPendingApprovals(storeOptions)
    .map((envelope) => envelope.approval_request)
    .filter((record) => validateApprovalRequestShape(record).valid);
}

module.exports = {
  APPROVAL_REQUEST_STATUSES,
  createApprovalRequest,
  decideApprovalRequest,
  getApprovalRequestById,
  getPendingApprovalRequests,
  isApprovalGranted,
  // Durable pending state (approvals/approvalStore.js).
  createAndPersistApprovalRequest,
  decideAndPersistApprovalRequest,
  loadPendingApprovalRequests,
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
