'use strict';

// The Usage Ledger. Turns usage/usageRecordModel.js's schema into a real, append-only
// record of every model call, tool call, external API call, research operation, and
// agent task a single agent/core/orchestratorExecutionContract.js run produces -
// shaped so a future SaaS pricing/metering engine could consume it, without this
// module doing any pricing itself (no $ amounts, no plan/tier lookups).
//
// Standalone deliverable, following the same deliberate scope choice
// audit/auditTrail.js already made: there is no database or file-persistence layer
// here - this module is a set of functions over a caller-held ledger object. The
// Chief (agent/core/orchestratorExecutionContract.js) creates one ledger per run via
// createUsageLedger() and threads it through every step; nothing here holds hidden
// state.
//
// DISTINCT FROM agent/core/usageLimits.js: that module is a budget *gate* (a plain
// {toolCalls, modelCalls, researchCalls, externalApiCalls} counter, checked against
// configurable ceilings before a call is allowed). This module is a *ledger* (one
// structured, frozen record per real dispatch, carrying business_id/tokens/model/
// quantity). Both are threaded through the same call chain and consulted at the same
// call site, but neither duplicates the other's job - see
// agent/core/orchestratorExecutionContract.js's runExecutor.
//
// APPEND-ONLY, MUTATED IN PLACE: appendUsageEvent() only ever pushes a new record
// onto the ledger's `events` array - it never edits a past event, matching
// audit/auditTrail.js's appendAuditEvent() convention exactly.
//
// NO SECRETS, NO UNNECESSARY SENSITIVE DATA: `detail` is passed through
// audit/auditTrail.js's exported redactSensitiveData() - reused directly, not
// reimplemented, so both ledgers share one redaction rule.
//
// BACKWARD COMPATIBLE BY CONSTRUCTION: appendUsageEvent() silently no-ops when
// handed a falsy ledger, matching appendAuditEvent()'s same additive-parameter
// pattern - every call site that does not yet pass a ledger keeps working unchanged.
//
// business_id IS TAGGED PER RECORD (not just on the ledger container) - unlike
// audit/auditTrail.js's tracker, where only the container carries business_id and it
// never survives into the response. A future pricing engine needs to sum usage by
// business straight from the raw event list, so each usage record carries its own
// business_id independently of the ledger it lives in.

const { redactSensitiveData } = require('../audit/auditTrail');
const { USAGE_EVENT_CATEGORIES, createEmptyUsageRecord, validateUsageRecordShape } = require('./usageRecordModel');

const MAX_SUMMARY_LENGTH = 300;

function truncateString(value) {
  if (typeof value !== 'string' || value.length <= MAX_SUMMARY_LENGTH) return value;
  return `${value.slice(0, MAX_SUMMARY_LENGTH)}…[TRUNCATED]`;
}

function requireNonEmptyString(value, fieldName, fnName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fnName} requires a non-empty \`${fieldName}\` string.`);
  }
}

// ---------------------------------------------------------------------------------
// createUsageRecord
// ---------------------------------------------------------------------------------

function createUsageRecord({
  runId,
  seq,
  businessId = null,
  category,
  specialistId = null,
  capabilityId = null,
  toolId = null,
  status = null,
  isExternalApi = false,
  isResearch = false,
  tokens = null,
  model = null,
  quantity,
  summary,
  detail = null,
} = {}) {
  const fnName = 'createUsageRecord';

  requireNonEmptyString(runId, 'runId', fnName);
  requireNonEmptyString(summary, 'summary', fnName);
  if (typeof seq !== 'number' || seq < 0 || !Number.isInteger(seq)) {
    throw new Error(`${fnName} requires \`seq\` to be a non-negative integer.`);
  }
  if (!USAGE_EVENT_CATEGORIES.includes(category)) {
    throw new Error(`${fnName} requires \`category\` to be one of: ${USAGE_EVENT_CATEGORIES.join(', ')}, got '${category}'.`);
  }
  if (typeof quantity !== 'number' || quantity < 0) {
    throw new Error(`${fnName} requires \`quantity\` to be a non-negative number.`);
  }
  if (detail !== null && (typeof detail !== 'object' || Array.isArray(detail))) {
    throw new Error(`${fnName} requires \`detail\` to be an object or null.`);
  }
  if (tokens !== null) {
    for (const tokenField of ['input', 'output', 'total']) {
      if (typeof tokens[tokenField] !== 'number') {
        throw new Error(`${fnName} requires \`tokens.${tokenField}\` to be a number when \`tokens\` is supplied.`);
      }
    }
  }

  const record = createEmptyUsageRecord(`${runId}-${seq}`);
  record.run_id = runId;
  record.business_id = businessId;
  record.category = category;
  record.timestamp = new Date().toISOString();
  record.specialist_id = specialistId;
  record.capability_id = capabilityId;
  record.tool_id = toolId;
  record.status = status;
  record.is_external_api = Boolean(isExternalApi);
  record.is_research = Boolean(isResearch);
  record.tokens = tokens;
  record.model = model;
  record.quantity = quantity;
  record.summary = truncateString(summary.trim()).slice(0, MAX_SUMMARY_LENGTH);
  record.detail = detail ? redactSensitiveData(detail) : null;

  const validation = validateUsageRecordShape(record);
  if (!validation.valid) {
    throw new Error(`Composed Usage Record failed validation: ${validation.errors.join('; ')}`);
  }
  return Object.freeze(record);
}

// ---------------------------------------------------------------------------------
// Ledger - one per agent/core/orchestratorExecutionContract.js run.
// ---------------------------------------------------------------------------------

// businessId is optional (additive) - which business this run's ledger belongs to.
// null for today's default single-business behavior. Also tagged onto every
// individual record (see appendUsageEvent) so a record survives independently of
// this container.
function createUsageLedger(runId, businessId = null) {
  requireNonEmptyString(runId, 'runId', 'createUsageLedger');
  return { run_id: runId, business_id: businessId, events: [] };
}

// Appends one new event to `ledger.events` (mutated in place - see header). No-ops
// and returns null when `ledger` is falsy, so callers that don't yet pass a ledger
// are unaffected. `fields.businessId` may override the ledger's own business_id;
// omitted, it defaults to the ledger's business_id.
function appendUsageEvent(ledger, fields = {}) {
  if (!ledger) return null;
  const seq = ledger.events.length;
  const businessId = 'businessId' in fields ? fields.businessId : ledger.business_id;
  const record = createUsageRecord({ ...fields, runId: ledger.run_id, seq, businessId });
  ledger.events.push(record);
  return record;
}

// ---------------------------------------------------------------------------------
// Read helpers - pure, no mutation.
// ---------------------------------------------------------------------------------

function requireLedger(ledger, fnName) {
  if (!ledger || !Array.isArray(ledger.events)) {
    throw new Error(`${fnName} requires a ledger created by createUsageLedger().`);
  }
}

function getEventsByCategory(ledger, category) {
  requireLedger(ledger, 'getEventsByCategory');
  return ledger.events.filter((event) => event.category === category);
}

function getEventsByBusiness(ledger, businessId) {
  requireLedger(ledger, 'getEventsByBusiness');
  return ledger.events.filter((event) => event.business_id === businessId);
}

// Pure arithmetic rollup - no $ amounts, no plan/tier lookups (out of scope; see
// usage/usageTracker.js's header). Returns all-zero aggregates for an empty ledger,
// never undefined/NaN.
function summarizeUsage(ledger) {
  requireLedger(ledger, 'summarizeUsage');

  const byCategory = {};
  for (const category of USAGE_EVENT_CATEGORIES) {
    byCategory[category] = { count: 0 };
  }
  byCategory.model_call.tokens_input = 0;
  byCategory.model_call.tokens_output = 0;
  byCategory.model_call.tokens_total = 0;

  // api_call/research_op are never a record's `category` value itself (see
  // usage/usageRecordModel.js's header) - they're non-exclusive tags
  // (is_external_api/is_research) that can appear on a model_call or tool_call
  // record. Their counts here are tag counts across all events, not a
  // category-equality count, so a model_call that also happens to be an external
  // API call (e.g. ai_reasoning_completion) is correctly counted in both buckets.
  for (const event of ledger.events) {
    const bucket = byCategory[event.category];
    bucket.count += 1;
    if (event.category === 'model_call' && event.tokens) {
      bucket.tokens_input += event.tokens.input;
      bucket.tokens_output += event.tokens.output;
      bucket.tokens_total += event.tokens.total;
    }
    if (event.is_external_api) byCategory.api_call.count += 1;
    if (event.is_research) byCategory.research_op.count += 1;
  }

  return {
    run_id: ledger.run_id,
    business_id: ledger.business_id,
    total_events: ledger.events.length,
    by_category: byCategory,
  };
}

module.exports = {
  createUsageRecord,
  createUsageLedger,
  appendUsageEvent,
  getEventsByCategory,
  getEventsByBusiness,
  summarizeUsage,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Usage Ledger (append-only log over a caller-held ledger):\n');

  const ledger = createUsageLedger('run-demo-1', 'acme-store');
  appendUsageEvent(ledger, {
    category: 'agent_task',
    specialistId: 'research',
    quantity: 1,
    summary: "Routed clause to specialist 'research'.",
  });
  appendUsageEvent(ledger, {
    category: 'research_op',
    specialistId: 'research',
    toolId: 'market_research',
    status: 'success',
    isResearch: true,
    quantity: 1,
    summary: "Tool 'market_research' completed successfully.",
  });
  appendUsageEvent(ledger, {
    category: 'model_call',
    toolId: 'ai_reasoning_completion',
    status: 'success',
    isExternalApi: true,
    tokens: { input: 120, output: 340, total: 460 },
    model: 'claude-sonnet-5',
    quantity: 460,
    summary: "Tool 'ai_reasoning_completion' completed successfully.",
    detail: { apiKey: 'sk-ant-should-never-appear-in-the-record' },
  });

  console.log(JSON.stringify(ledger, null, 2));
  console.log('\nSummary:');
  console.log(JSON.stringify(summarizeUsage(ledger), null, 2));
  console.log('\nNote: the injected apiKey value above is redacted, not the raw secret - confirm this in the output.');
}
