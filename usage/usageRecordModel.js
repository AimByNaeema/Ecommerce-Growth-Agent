'use strict';

// The shape of one Usage Record - a single billable-shaped event in the structured
// usage ledger CLAUDE.md section 3 names as shared infrastructure ("Cost/token
// controls"), distinct from audit/auditRecordModel.js's general "what happened"
// event log. Schema and a couple of pure helpers only, following the exact
// convention of every existing *Model.js file (field list + createEmpty* +
// validate*Shape + CLI printer) - the actual recording lives in usage/usageTracker.js.
//
// Five categories, not six: "token usage" is not a standalone category but a
// `tokens` field ON a model_call record - a token count divorced from the model
// call that produced it has no independent billing meaning (a future pricing
// engine bills "N input + M output tokens on model X," which IS the model_call
// record). `api_call` and `research_op` are non-exclusive tags carried on a
// tool_call record (see `is_external_api`/`is_research` below), reusing
// agent/core/usageLimits.js's own EXTERNAL_API_TOOL_IDS/RESEARCH_TOOL_IDS
// classification rather than re-deriving it - one real dispatch is always exactly
// one record, never split into two just because it matches two categories.
const USAGE_EVENT_CATEGORIES = ['model_call', 'tool_call', 'api_call', 'research_op', 'agent_task'];

const USAGE_RECORD_FIELDS = [
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
    description: 'Correlates every usage event produced by one agent/core/orchestratorExecutionContract.js run.',
  },
  {
    id: 'business_id',
    title: 'Business id',
    type: 'string | null',
    description:
      'Which business this event belongs to (configuration/businessRegistry.js) - tagged per record (not just per-ledger) so a future pricing engine can sum usage by business directly from the raw event list.',
  },
  {
    id: 'category',
    title: 'Category',
    type: `enum: ${USAGE_EVENT_CATEGORIES.join(' | ')}`,
    description: 'Which of the 5 tracked usage categories this event represents.',
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
    description: 'The tools/toolRegistry.js tool id involved - null when not applicable (e.g. an agent_task event before any tool is matched).',
  },
  {
    id: 'status',
    title: 'Status',
    type: 'string | null',
    description: "The outcome this event reflects (e.g. 'success', 'error') - null when not applicable.",
  },
  {
    id: 'is_external_api',
    title: 'Is external API',
    type: 'boolean',
    description: "Whether the underlying tool id is in agent/core/usageLimits.js's EXTERNAL_API_TOOL_IDS - reused, not re-derived.",
  },
  {
    id: 'is_research',
    title: 'Is research',
    type: 'boolean',
    description: "Whether the underlying tool id is in agent/core/usageLimits.js's RESEARCH_TOOL_IDS - reused, not re-derived.",
  },
  {
    id: 'tokens',
    title: 'Tokens',
    type: 'object | null',
    description: "{ input, output, total } - populated only for category 'model_call', null otherwise.",
  },
  {
    id: 'model',
    title: 'Model',
    type: 'string | null',
    description: "The model id that actually served the call - populated only for category 'model_call', null otherwise.",
  },
  {
    id: 'quantity',
    title: 'Quantity',
    type: 'number',
    description:
      "The billable quantity this event represents: 1 for tool_call/api_call/research_op/agent_task, tokens.total for model_call (0 on a refused/errored call) - lets a future summer do one generic sum(quantity) group by category with no category-specific logic.",
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

const OBJECT_OR_NULL_FIELD_IDS = ['tokens', 'detail'];
const BOOLEAN_FIELD_IDS = ['is_external_api', 'is_research'];

// Returns a blank Usage Record conforming to USAGE_RECORD_FIELDS. No real event yet -
// callers (usage/usageTracker.js) fill it in.
function createEmptyUsageRecord(id = '') {
  return {
    id,
    run_id: '',
    business_id: null,
    category: '',
    timestamp: '',
    specialist_id: null,
    capability_id: null,
    tool_id: null,
    status: null,
    is_external_api: false,
    is_research: false,
    tokens: null,
    model: null,
    quantity: 0,
    summary: '',
    detail: null,
  };
}

// Checks that a Usage Record has exactly the expected keys, with the expected basic
// shapes. Does not guess or fill in anything missing - only reports.
function validateUsageRecordShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = USAGE_RECORD_FIELDS.map((field) => field.id);
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

  for (const id of BOOLEAN_FIELD_IDS) {
    if (id in record && typeof record[id] !== 'boolean') {
      errors.push(`${id} must be a boolean`);
    }
  }

  if ('id' in record && (typeof record.id !== 'string' || record.id.trim() === '')) {
    errors.push('id must be a non-empty string');
  }
  if ('run_id' in record && (typeof record.run_id !== 'string' || record.run_id.trim() === '')) {
    errors.push('run_id must be a non-empty string');
  }
  if ('business_id' in record && record.business_id !== null && typeof record.business_id !== 'string') {
    errors.push('business_id must be a string or null');
  }
  if ('category' in record && !USAGE_EVENT_CATEGORIES.includes(record.category)) {
    errors.push(`category must be one of: ${USAGE_EVENT_CATEGORIES.join(', ')}`);
  }
  if ('summary' in record && (typeof record.summary !== 'string' || record.summary.trim() === '')) {
    errors.push('summary must be a non-empty string');
  }
  if ('quantity' in record && typeof record.quantity !== 'number') {
    errors.push('quantity must be a number');
  }
  if ('model' in record && record.model !== null && typeof record.model !== 'string') {
    errors.push('model must be a string or null');
  }
  if (record.tokens) {
    for (const tokenField of ['input', 'output', 'total']) {
      if (typeof record.tokens[tokenField] !== 'number') {
        errors.push(`tokens.${tokenField} must be a number`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  USAGE_EVENT_CATEGORIES,
  USAGE_RECORD_FIELDS,
  createEmptyUsageRecord,
  validateUsageRecordShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Usage Record model (schema only):\n');
  USAGE_RECORD_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyUsageRecord('(no id set)'), null, 2));
}
