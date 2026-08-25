'use strict';

// The shape of one Approval Request - a real, trackable record of one action that
// agent/core/toolPermissions.js's checkToolAccess() decided needs explicit human
// sign-off before it can proceed (decision === 'approval_required', per
// approvals/approvalArchitecture.js's 'approval_required_by_default' policy rule).
// Schema and a couple of pure helpers only, following the exact convention of every
// existing *Model.js file (field list + createEmpty* + validate*Shape + CLI printer)
// - the actual pending -> approved/rejected lifecycle logic lives in
// approvals/approvalWorkflow.js.
//
// `classification` always reuses one of approvals/approvalArchitecture.js's own 4 ids
// (validated via getClassificationById, never redefined here). `execution_request` is
// the exact request object agent/core/orchestratorExecutionContract.js would have
// passed to a tool executor, relayed as-is so a later approval can actually resume the
// same call (see agent/core/orchestratorExecutionContract.js's resumeApprovedExecution)
// rather than requiring the caller to reconstruct it from scratch. `id` is always
// caller-supplied - like every other record in this project (e.g.
// agent/core/experimentModel.js's experiment_id), nothing here generates a random or
// counter-based id internally, keeping every record deterministic and reproducible.
//
// ACCOUNTABILITY: `decided_by`/`decided_at`/`decision_notes` only ever get filled in
// by approvals/approvalWorkflow.js's decideApprovalRequest() - never guessed, never
// defaulted to a placeholder identity. A record with status 'pending' always has all
// three as null; CLAUDE.md rule 7 ("the agent must never silently perform" a
// consequential action) is exactly why a missing decided_by is not tolerated once a
// record leaves 'pending'.

const { getClassificationById } = require('./approvalArchitecture');

const APPROVAL_REQUEST_STATUSES = ['pending', 'approved', 'rejected'];

const APPROVAL_REQUEST_FIELDS = [
  {
    id: 'id',
    title: 'Id',
    type: 'string',
    description: 'Caller-supplied unique identifier for this request within its run - never generated internally.',
  },
  {
    id: 'classification',
    title: 'Classification',
    type: 'string',
    description: "One of approvals/approvalArchitecture.js's ACTION_CLASSIFICATIONS ids - reused, never redefined.",
  },
  {
    id: 'specialist_id',
    title: 'Specialist id',
    type: 'string | null',
    description: 'Which specialist this request belongs to - null for a shared-infrastructure request.',
  },
  {
    id: 'tool_id',
    title: 'Tool id',
    type: 'string',
    description: 'The tools/toolRegistry.js tool id this request is asking permission to execute.',
  },
  {
    id: 'execution_request',
    title: 'Execution request',
    type: 'object',
    description: "The exact execution request to re-run once approved - relayed as-is, never rebuilt from scratch at resume time.",
  },
  {
    id: 'reason',
    title: 'Reason',
    type: 'string',
    description: "Why approval is required, relayed from agent/core/toolPermissions.js's checkToolAccess() reason.",
  },
  {
    id: 'status',
    title: 'Status',
    type: `enum: ${APPROVAL_REQUEST_STATUSES.join(' | ')}`,
    description: "This request's current position in the pending -> approved/rejected lifecycle.",
  },
  {
    id: 'requested_at',
    title: 'Requested at',
    type: 'string',
    description: 'When this request was created (ISO timestamp).',
  },
  {
    id: 'decided_at',
    title: 'Decided at',
    type: 'string | null',
    description: "When a human decision was recorded - null while status is 'pending'.",
  },
  {
    id: 'decided_by',
    title: 'Decided by',
    type: 'string | null',
    description: "Who made the decision - null while status is 'pending'; required to ever leave 'pending'.",
  },
  {
    id: 'decision_notes',
    title: 'Decision notes',
    type: 'string | null',
    description: 'Optional caller-supplied context for the decision.',
  },
];

const OBJECT_FIELD_IDS = APPROVAL_REQUEST_FIELDS.filter((field) => field.type === 'object').map((field) => field.id);

// Returns a blank Approval Request record conforming to APPROVAL_REQUEST_FIELDS. No
// real request yet - callers (approvals/approvalWorkflow.js) fill it in.
function createEmptyApprovalRequest(id = '') {
  return {
    id,
    classification: '',
    specialist_id: null,
    tool_id: '',
    execution_request: {},
    reason: '',
    status: 'pending',
    requested_at: '',
    decided_at: null,
    decided_by: null,
    decision_notes: null,
  };
}

// Checks that an Approval Request record has exactly the expected keys, with the
// expected basic shapes. Does not guess or fill in anything missing - only reports.
function validateApprovalRequestShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = APPROVAL_REQUEST_FIELDS.map((field) => field.id);
  const actualIds = Object.keys(record);

  for (const id of expectedIds) {
    if (!actualIds.includes(id)) errors.push(`missing field: ${id}`);
  }
  for (const id of actualIds) {
    if (!expectedIds.includes(id)) errors.push(`unexpected field: ${id}`);
  }

  for (const id of OBJECT_FIELD_IDS) {
    if (id in record && (typeof record[id] !== 'object' || record[id] === null || Array.isArray(record[id]))) {
      errors.push(`${id} must be an object`);
    }
  }

  if ('status' in record && !APPROVAL_REQUEST_STATUSES.includes(record.status)) {
    errors.push(`status must be one of: ${APPROVAL_REQUEST_STATUSES.join(', ')}`);
  }
  if ('classification' in record && !getClassificationById(record.classification)) {
    errors.push(`classification must be one of approvals/approvalArchitecture.js's real classification ids, got '${record.classification}'`);
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  APPROVAL_REQUEST_STATUSES,
  APPROVAL_REQUEST_FIELDS,
  createEmptyApprovalRequest,
  validateApprovalRequestShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Approval Request model (schema only):\n');
  APPROVAL_REQUEST_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyApprovalRequest('(no id set)'), null, 2));
}
