'use strict';

// The shape of one Audit Record - a single traceable event in the centralized audit
// trail CLAUDE.md section 3 names as shared infrastructure ("a record of what actions
// were taken/proposed, by which specialist, and under what approval - so behavior is
// traceable after the fact"). Schema and a couple of pure helpers only, following the
// exact convention of every existing *Model.js file (field list + createEmpty* +
// validate*Shape + CLI printer) - the actual recording/redaction logic lives in
// audit/auditTrail.js.
//
// `type` is always one of AUDIT_EVENT_TYPES, one entry per category
// agent/core/orchestratorExecutionContract.js's real dispatch flow can produce: a
// request comes in, a specialist agent is selected, a tool is invoked, request data is
// accessed by that tool, a recommendation may be produced, an approval may be
// requested/decided, execution happens, a result comes back, or an error occurs.
//
// `id` is auto-composed from `run_id` + a per-run sequence number (unlike
// approvals/approvalRequestModel.js's caller-supplied `id`) - audit events fire far
// more often than approval requests, so a caller-held per-run tracker
// (audit/auditTrail.js's createAuditTracker/appendAuditEvent) generates them instead.
//
// `detail` is the one field allowed to carry extra structured data, and the one field
// that must never carry a raw secret or unbounded payload - audit/auditTrail.js's
// redactSensitiveData() is always applied to it before a record is created, never
// left opt-in.

const AUDIT_EVENT_TYPES = [
  'request',
  'agent',
  'tools',
  'data_access',
  'recommendation',
  'approval',
  'execution',
  'result',
  'error',
];

const AUDIT_RECORD_FIELDS = [
  {
    id: 'id',
    title: 'Id',
    type: 'string',
    description: 'Auto-composed as `${run_id}-${sequence number within the run}` - never caller-supplied.',
  },
  {
    id: 'run_id',
    title: 'Run id',
    type: 'string',
    description: 'Correlates every event produced by one agent/core/orchestratorExecutionContract.js run.',
  },
  {
    id: 'type',
    title: 'Type',
    type: `enum: ${AUDIT_EVENT_TYPES.join(' | ')}`,
    description: 'Which tracked category this event belongs to.',
  },
  {
    id: 'timestamp',
    title: 'Timestamp',
    type: 'string',
    description: 'When this event was recorded (ISO timestamp).',
  },
  {
    id: 'specialist_id',
    title: 'Specialist id',
    type: 'string | null',
    description: 'Which specialist this event belongs to - null when not specialist-scoped.',
  },
  {
    id: 'capability_id',
    title: 'Capability id',
    type: 'string | null',
    description: "The specialist capability/task id involved (agent/core/specialistCapabilityRegistry.js's task id) - null when not applicable.",
  },
  {
    id: 'tool_id',
    title: 'Tool id',
    type: 'string | null',
    description: 'The tools/toolRegistry.js tool id involved - null when not applicable.',
  },
  {
    id: 'classification',
    title: 'Classification',
    type: 'string | null',
    description: "One of approvals/approvalArchitecture.js's ACTION_CLASSIFICATIONS ids - null when not applicable.",
  },
  {
    id: 'status',
    title: 'Status',
    type: 'string | null',
    description: "The outcome/decision status this event reflects (e.g. 'success', 'error', 'pending', 'approved') - null when not applicable.",
  },
  {
    id: 'summary',
    title: 'Summary',
    type: 'string',
    description: 'Required, human-readable description of the event, truncated to 300 characters.',
  },
  {
    id: 'detail',
    title: 'Detail',
    type: 'object | null',
    description: 'Optional structured payload, always passed through audit/auditTrail.js\'s redactSensitiveData() before storage.',
  },
];

const OBJECT_OR_NULL_FIELD_IDS = ['detail'];

// Returns a blank Audit Record conforming to AUDIT_RECORD_FIELDS. No real event yet -
// callers (audit/auditTrail.js) fill it in.
function createEmptyAuditRecord(id = '') {
  return {
    id,
    run_id: '',
    type: '',
    timestamp: '',
    specialist_id: null,
    capability_id: null,
    tool_id: null,
    classification: null,
    status: null,
    summary: '',
    detail: null,
  };
}

// Checks that an Audit Record has exactly the expected keys, with the expected basic
// shapes. Does not guess or fill in anything missing - only reports.
function validateAuditRecordShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = AUDIT_RECORD_FIELDS.map((field) => field.id);
  const actualIds = Object.keys(record);

  for (const id of expectedIds) {
    if (!actualIds.includes(id)) errors.push(`missing field: ${id}`);
  }
  for (const id of actualIds) {
    if (!expectedIds.includes(id)) errors.push(`unexpected field: ${id}`);
  }

  for (const id of OBJECT_OR_NULL_FIELD_IDS) {
    if (id in record && record[id] !== null && (typeof record[id] !== 'object' || Array.isArray(record[id]))) {
      errors.push(`${id} must be an object or null`);
    }
  }

  if ('id' in record && (typeof record.id !== 'string' || record.id.trim() === '')) {
    errors.push('id must be a non-empty string');
  }
  if ('run_id' in record && (typeof record.run_id !== 'string' || record.run_id.trim() === '')) {
    errors.push('run_id must be a non-empty string');
  }
  if ('type' in record && !AUDIT_EVENT_TYPES.includes(record.type)) {
    errors.push(`type must be one of: ${AUDIT_EVENT_TYPES.join(', ')}`);
  }
  if ('summary' in record && (typeof record.summary !== 'string' || record.summary.trim() === '')) {
    errors.push('summary must be a non-empty string');
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  AUDIT_EVENT_TYPES,
  AUDIT_RECORD_FIELDS,
  createEmptyAuditRecord,
  validateAuditRecordShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Audit Record model (schema only):\n');
  AUDIT_RECORD_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyAuditRecord('(no id set)'), null, 2));
}
