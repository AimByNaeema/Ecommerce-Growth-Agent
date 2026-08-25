'use strict';

// The Audit Trail. Turns audit/auditRecordModel.js's schema into a real, append-only
// log of every tracked event (request, agent, tools, data_access, recommendation,
// approval, execution, result, error) a single agent/core/orchestratorExecutionContract.js
// run produces.
//
// Standalone deliverable, following the same deliberate scope choice
// approvals/approvalWorkflow.js and agent/core/experimentLearningStore.js already made:
// there is no database or file-persistence layer here (agent/core/memory/ has no
// persistence engine implemented yet, and adding one is an unscoped technical decision
// per CLAUDE.md rule 15) - this module is a set of functions over a caller-held
// tracker object. The Chief (agent/core/orchestratorExecutionContract.js) creates one
// tracker per run via createAuditTracker() and threads it through every step; nothing
// here holds hidden state.
//
// APPEND-ONLY, MUTATED IN PLACE: unlike approvals/approvalWorkflow.js's
// decideApprovalRequest() (which returns a new array because an existing record
// changes), appendAuditEvent() only ever pushes a new record onto the tracker's
// `events` array - it never edits a past event, so mutating that array in place is
// safe and matches the exact convention agent/core/orchestratorExecutionContract.js
// already uses for its own per-run trackers (runTokenTracker, runApprovalTracker).
//
// NO SECRETS, NO UNNECESSARY SENSITIVE DATA: redactSensitiveData() is applied to every
// record's `detail` field unconditionally inside createAuditRecord() - there is no
// opt-out. It strips any value whose key looks like a credential (password, token,
// secret, api key, access token, credential, authorization, private key, ssn, client
// secret) and truncates any string over 500 characters, so a record can never become a
// backdoor for leaking a secret or dumping an unbounded payload into the trail.
//
// BACKWARD COMPATIBLE BY CONSTRUCTION: appendAuditEvent() silently no-ops when handed
// a falsy tracker, matching the additive-4th-argument pattern already used elsewhere in
// this codebase (agent/core/orchestratorExecutionContract.js's createExecutionRequest)
// - every call site that does not yet pass a tracker keeps working unchanged.

const { AUDIT_EVENT_TYPES, createEmptyAuditRecord, validateAuditRecordShape } = require('./auditRecordModel');

const SENSITIVE_KEY_PATTERN =
  /password|token|secret|api[_-]?key|access[_-]?key|credential|authoriz(a|e)tion|private[_-]?key|ssn|client[_-]?secret/i;

const MAX_DETAIL_STRING_LENGTH = 500;
const MAX_SUMMARY_LENGTH = 300;

function truncateString(value) {
  if (typeof value !== 'string' || value.length <= MAX_DETAIL_STRING_LENGTH) return value;
  return `${value.slice(0, MAX_DETAIL_STRING_LENGTH)}…[TRUNCATED]`;
}

// Pure - deep-clones and walks `value`, redacting any object value whose key looks
// like a credential and truncating long strings. Never mutates its input.
function redactSensitiveData(value) {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveData(item));
  }
  if (value && typeof value === 'object') {
    const redacted = {};
    for (const [key, val] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        redacted[key] = '[REDACTED]';
      } else {
        redacted[key] = redactSensitiveData(val);
      }
    }
    return redacted;
  }
  if (typeof value === 'string') {
    return truncateString(value);
  }
  return value;
}

function requireNonEmptyString(value, fieldName, fnName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fnName} requires a non-empty \`${fieldName}\` string.`);
  }
}

// ---------------------------------------------------------------------------------
// createAuditRecord
// ---------------------------------------------------------------------------------

function createAuditRecord({
  runId,
  seq,
  type,
  specialistId = null,
  capabilityId = null,
  toolId = null,
  classification = null,
  status = null,
  summary,
  detail = null,
} = {}) {
  const fnName = 'createAuditRecord';

  requireNonEmptyString(runId, 'runId', fnName);
  requireNonEmptyString(summary, 'summary', fnName);
  if (typeof seq !== 'number' || seq < 0 || !Number.isInteger(seq)) {
    throw new Error(`${fnName} requires \`seq\` to be a non-negative integer.`);
  }
  if (!AUDIT_EVENT_TYPES.includes(type)) {
    throw new Error(`${fnName} requires \`type\` to be one of: ${AUDIT_EVENT_TYPES.join(', ')}, got '${type}'.`);
  }
  if (detail !== null && (typeof detail !== 'object' || Array.isArray(detail))) {
    throw new Error(`${fnName} requires \`detail\` to be an object or null.`);
  }

  const record = createEmptyAuditRecord(`${runId}-${seq}`);
  record.run_id = runId;
  record.type = type;
  record.timestamp = new Date().toISOString();
  record.specialist_id = specialistId;
  record.capability_id = capabilityId;
  record.tool_id = toolId;
  record.classification = classification;
  record.status = status;
  record.summary = truncateString(summary.trim()).slice(0, MAX_SUMMARY_LENGTH);
  record.detail = detail ? redactSensitiveData(detail) : null;

  const validation = validateAuditRecordShape(record);
  if (!validation.valid) {
    throw new Error(`Composed Audit Record failed validation: ${validation.errors.join('; ')}`);
  }
  return Object.freeze(record);
}

// ---------------------------------------------------------------------------------
// Tracker - one per agent/core/orchestratorExecutionContract.js run.
// ---------------------------------------------------------------------------------

function createAuditTracker(runId) {
  requireNonEmptyString(runId, 'runId', 'createAuditTracker');
  return { run_id: runId, events: [] };
}

// Appends one new event to `tracker.events` (mutated in place - see header). No-ops
// and returns null when `tracker` is falsy, so callers that don't yet pass a tracker
// are unaffected.
function appendAuditEvent(tracker, fields = {}) {
  if (!tracker) return null;
  const seq = tracker.events.length;
  const record = createAuditRecord({ ...fields, runId: tracker.run_id, seq });
  tracker.events.push(record);
  return record;
}

// ---------------------------------------------------------------------------------
// Read helpers - pure, no mutation.
// ---------------------------------------------------------------------------------

function requireTracker(tracker, fnName) {
  if (!tracker || !Array.isArray(tracker.events)) {
    throw new Error(`${fnName} requires a tracker created by createAuditTracker().`);
  }
}

function getEventsByType(tracker, type) {
  requireTracker(tracker, 'getEventsByType');
  return tracker.events.filter((event) => event.type === type);
}

function getEventsBySpecialist(tracker, specialistId) {
  requireTracker(tracker, 'getEventsBySpecialist');
  return tracker.events.filter((event) => event.specialist_id === specialistId);
}

function getErrorEvents(tracker) {
  return getEventsByType(tracker, 'error');
}

module.exports = {
  redactSensitiveData,
  createAuditRecord,
  createAuditTracker,
  appendAuditEvent,
  getEventsByType,
  getEventsBySpecialist,
  getErrorEvents,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Audit Trail (append-only log over a caller-held tracker):\n');

  const tracker = createAuditTracker('run-demo-1');
  appendAuditEvent(tracker, { type: 'request', summary: 'Objective received: research the market for eco-friendly water bottles.' });
  appendAuditEvent(tracker, { type: 'agent', specialistId: 'research', capabilityId: 'market_research', summary: 'Routed to the research specialist.' });
  appendAuditEvent(tracker, {
    type: 'tools',
    specialistId: 'research',
    toolId: 'market_research',
    summary: "Invoking tool 'market_research'.",
  });
  appendAuditEvent(tracker, {
    type: 'data_access',
    toolId: 'market_research',
    summary: "Tool 'market_research' read its declared input fields.",
    detail: { fields: ['market', 'demandSignals'], apiKey: 'sk-ant-should-never-appear-in-the-record' },
  });
  appendAuditEvent(tracker, { type: 'execution', toolId: 'market_research', summary: "Executing tool 'market_research'." });
  appendAuditEvent(tracker, { type: 'result', toolId: 'market_research', status: 'success', summary: "Tool 'market_research' completed successfully." });

  console.log(JSON.stringify(tracker, null, 2));
  console.log('\nNote: the injected apiKey value above is redacted, not the raw secret - confirm this in the output.');
}
