'use strict';

// The shape of one Specialist Capability Registry entry - the per-specialist
// declaration CLAUDE.md section 2/3 implies but no single file previously stated:
// what a specialist can do (supported_tasks), what tools that requires
// (required_tools), what permission that grants (permissions), and what approval
// that carries (approval_requirements). Schema only, following the exact convention
// of every existing *Model.js file (field list + createEmpty* + validate*Shape +
// CLI printer) - no composition/derivation logic lives here. That logic lives in
// agent/core/specialistCapabilityRegistry.js, which builds real
// SPECIALIST_CAPABILITY_REGISTRY entries conforming to this shape by requiring and
// reusing agent/core/specialistRegistry.js, tools/toolRegistry.js,
// agent/core/toolPermissions.js, and approvals/approvalArchitecture.js - never by
// duplicating their data.
//
// Two record shapes are defined here:
//
// CAPABILITY_TASK_FIELDS - one supported task/capability a specialist offers (e.g.
// SEO's 'keyword_research'). tool_ids may be an empty array where no tool in
// tools/toolRegistry.js wraps that capability yet - an honest gap, not an error (see
// agent/core/specialistCapabilityRegistry.js's header comment for the exact list of
// known gaps). input_contract/output_contract are the caller-facing "what must I
// supply" / "what will I get back" declarations this registry exists to provide.
//
// SPECIALIST_CAPABILITY_ENTRY_FIELDS - one specialist's full entry: identity fields
// reused verbatim from agent/core/specialistRegistry.js, a list of
// CAPABILITY_TASK_FIELDS-shaped supported_tasks, the tool ids required across all of
// them, and the permissions/approval_requirements consequences of those tool ids
// (reused verbatim from agent/core/toolPermissions.js's checkToolAccess() and
// approvals/approvalArchitecture.js's ACTION_CLASSIFICATIONS - never
// reimplemented).

const { SPECIALIST_STATUSES } = require('./specialistRegistry');

const INPUT_CONTRACT_SUB_KEYS = ['required', 'optional'];
const OUTPUT_CONTRACT_SUB_KEYS = ['model', 'fields'];
const PERMISSIONS_SUB_KEYS = ['categories', 'tool_access'];
const APPROVAL_REQUIREMENT_ENTRY_SUB_KEYS = [
  'tool_id',
  'classification',
  'title',
  'description',
  'requires_human_approval',
];

const CAPABILITY_TASK_FIELDS = [
  {
    id: 'id',
    title: 'Capability id',
    type: 'string',
    description: 'The capability/task identifier - reused verbatim from the specialist\'s own capability enum where one exists (e.g. SEO_CAPABILITIES), hand-authored only where none does (Product).',
  },
  {
    id: 'title',
    title: 'Title',
    type: 'string',
    description: 'A short human-readable name for this capability.',
  },
  {
    id: 'description',
    title: 'Description',
    type: 'string',
    description: 'What this capability actually does, grounded in the real handler function it dispatches to - never invented.',
  },
  {
    id: 'tool_ids',
    title: 'Tool ids',
    type: 'array',
    description: 'Which tools/toolRegistry.js tool id(s) wrap this capability today. May be empty - a real, currently-unwired capability - never fabricated to look complete.',
  },
  {
    id: 'input_contract',
    title: 'Input contract',
    type: 'object',
    description: '{ required: [...], optional: [...] } - the field names a caller must/may supply, grounded exactly in what the real handler enforces (throws on) or accepts.',
  },
  {
    id: 'output_contract',
    title: 'Output contract',
    type: 'object',
    description: '{ model, fields } - which *Model.js file defines the returned shape (or null for an ad hoc shape) and its real field id list, reused rather than re-typed.',
  },
  {
    id: 'live_data_tool_id',
    title: 'Live data tool id',
    type: 'string | null',
    description: 'A tools/toolRegistry.js tool id (must also appear in tool_ids) that can satisfy this capability entirely from an existing approved read-only live source, needing no caller-supplied structured evidence - null (the default) when no such source exists. Declarative only: this field never fabricates a live source, it only names one that already exists and was verified against the tool\'s own real behavior (e.g. analytics_data_retrieval, product_data_retrieval).',
  },
];

const SPECIALIST_CAPABILITY_ENTRY_FIELDS = [
  {
    id: 'id',
    title: 'Specialist id',
    type: 'string',
    description: 'Reused verbatim from agent/core/specialistRegistry.js.',
  },
  {
    id: 'title',
    title: 'Title',
    type: 'string',
    description: 'Reused verbatim from agent/core/specialistRegistry.js.',
  },
  {
    id: 'description',
    title: 'Description',
    type: 'string',
    description: 'Reused verbatim from agent/core/specialistRegistry.js.',
  },
  {
    id: 'status',
    title: 'Status',
    type: `enum: ${SPECIALIST_STATUSES.join(' | ')}`,
    description: 'Reused verbatim from agent/core/specialistRegistry.js.',
  },
  {
    id: 'supported_tasks',
    title: 'Supported tasks',
    type: 'array',
    description: 'This specialist\'s capabilities, each shaped per CAPABILITY_TASK_FIELDS.',
  },
  {
    id: 'required_tools',
    title: 'Required tools',
    type: 'array',
    description: 'The tools/toolRegistry.js tool ids this specialist\'s categories cover, derived from agent/core/toolPermissions.js\'s SPECIALIST_TO_CATEGORIES - never hand-listed.',
  },
  {
    id: 'permissions',
    title: 'Permissions',
    type: 'object',
    description: '{ categories, tool_access } - categories this specialist is permitted to use, and the real agent/core/toolPermissions.js checkToolAccess() decision for each required tool.',
  },
  {
    id: 'approval_requirements',
    title: 'Approval requirements',
    type: 'array',
    description: 'Per required tool: { tool_id, classification, title, description, requires_human_approval }, looked up from approvals/approvalArchitecture.js\'s ACTION_CLASSIFICATIONS via that tool\'s classification.',
  },
];

const CAPABILITY_TASK_ARRAY_FIELD_IDS = CAPABILITY_TASK_FIELDS.filter((f) => f.type === 'array').map((f) => f.id);
const CAPABILITY_TASK_OBJECT_FIELD_IDS = CAPABILITY_TASK_FIELDS.filter((f) => f.type === 'object').map((f) => f.id);

const ENTRY_ARRAY_FIELD_IDS = SPECIALIST_CAPABILITY_ENTRY_FIELDS.filter((f) => f.type === 'array').map((f) => f.id);
const ENTRY_OBJECT_FIELD_IDS = SPECIALIST_CAPABILITY_ENTRY_FIELDS.filter((f) => f.type === 'object').map((f) => f.id);

function createEmptyCapabilityTask(id = '') {
  return {
    id,
    title: '',
    description: '',
    tool_ids: [],
    input_contract: { required: [], optional: [] },
    output_contract: { model: null, fields: [] },
    live_data_tool_id: null,
  };
}

// Returns a blank specialist capability entry. status defaults to 'not_implemented' -
// the honest "nothing asserted yet" default shared with
// agent/core/specialistRegistry.js's SPECIALIST_STATUSES, never assumed implemented.
function createEmptySpecialistCapabilityEntry(id = '') {
  return {
    id,
    title: '',
    description: '',
    status: 'not_implemented',
    supported_tasks: [],
    required_tools: [],
    permissions: { categories: [], tool_access: [] },
    approval_requirements: [],
  };
}

function validateCapabilityTaskShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = CAPABILITY_TASK_FIELDS.map((f) => f.id);
  const actualIds = Object.keys(record);

  for (const id of expectedIds) {
    if (!actualIds.includes(id)) errors.push(`missing field: ${id}`);
  }
  for (const id of actualIds) {
    if (!expectedIds.includes(id)) errors.push(`unexpected field: ${id}`);
  }

  for (const id of CAPABILITY_TASK_ARRAY_FIELD_IDS) {
    if (id in record && !Array.isArray(record[id])) errors.push(`${id} must be an array`);
  }
  for (const id of CAPABILITY_TASK_OBJECT_FIELD_IDS) {
    if (id in record && (typeof record[id] !== 'object' || record[id] === null || Array.isArray(record[id]))) {
      errors.push(`${id} must be an object`);
    }
  }

  if ('input_contract' in record && typeof record.input_contract === 'object' && record.input_contract !== null) {
    const subIds = Object.keys(record.input_contract);
    for (const key of INPUT_CONTRACT_SUB_KEYS) {
      if (!subIds.includes(key)) errors.push(`input_contract is missing sub-field: ${key}`);
    }
    for (const key of subIds) {
      if (!INPUT_CONTRACT_SUB_KEYS.includes(key)) errors.push(`input_contract has unexpected sub-field: ${key}`);
    }
    if ('required' in record.input_contract && !Array.isArray(record.input_contract.required)) {
      errors.push('input_contract.required must be an array');
    }
    if ('optional' in record.input_contract && !Array.isArray(record.input_contract.optional)) {
      errors.push('input_contract.optional must be an array');
    }
  }

  if (
    'live_data_tool_id' in record &&
    record.live_data_tool_id !== null &&
    typeof record.live_data_tool_id !== 'string'
  ) {
    errors.push('live_data_tool_id must be a string or null');
  }
  if (
    typeof record.live_data_tool_id === 'string' &&
    Array.isArray(record.tool_ids) &&
    !record.tool_ids.includes(record.live_data_tool_id)
  ) {
    errors.push(`live_data_tool_id '${record.live_data_tool_id}' must also be present in tool_ids`);
  }

  if ('output_contract' in record && typeof record.output_contract === 'object' && record.output_contract !== null) {
    const subIds = Object.keys(record.output_contract);
    for (const key of OUTPUT_CONTRACT_SUB_KEYS) {
      if (!subIds.includes(key)) errors.push(`output_contract is missing sub-field: ${key}`);
    }
    for (const key of subIds) {
      if (!OUTPUT_CONTRACT_SUB_KEYS.includes(key)) errors.push(`output_contract has unexpected sub-field: ${key}`);
    }
    if (
      'model' in record.output_contract &&
      record.output_contract.model !== null &&
      typeof record.output_contract.model !== 'string'
    ) {
      errors.push('output_contract.model must be a string or null');
    }
    if ('fields' in record.output_contract && !Array.isArray(record.output_contract.fields)) {
      errors.push('output_contract.fields must be an array');
    }
  }

  return { valid: errors.length === 0, errors };
}

// Checks that a specialist capability entry has exactly the expected keys, with the
// expected basic shapes. Does not guess or fill in anything missing - only reports.
// Also cross-checks that every supported_tasks[i] is itself shape-valid, and that
// every tool_id a task references is actually present in the entry's own
// required_tools (catches authoring drift between the two derived/hand-authored
// pieces).
function validateSpecialistCapabilityEntryShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = SPECIALIST_CAPABILITY_ENTRY_FIELDS.map((f) => f.id);
  const actualIds = Object.keys(record);

  for (const id of expectedIds) {
    if (!actualIds.includes(id)) errors.push(`missing field: ${id}`);
  }
  for (const id of actualIds) {
    if (!expectedIds.includes(id)) errors.push(`unexpected field: ${id}`);
  }

  for (const id of ENTRY_ARRAY_FIELD_IDS) {
    if (id in record && !Array.isArray(record[id])) errors.push(`${id} must be an array`);
  }
  for (const id of ENTRY_OBJECT_FIELD_IDS) {
    if (id in record && (typeof record[id] !== 'object' || record[id] === null || Array.isArray(record[id]))) {
      errors.push(`${id} must be an object`);
    }
  }

  if ('status' in record && !SPECIALIST_STATUSES.includes(record.status)) {
    errors.push(`status must be one of: ${SPECIALIST_STATUSES.join(', ')}`);
  }

  if ('permissions' in record && typeof record.permissions === 'object' && record.permissions !== null) {
    const subIds = Object.keys(record.permissions);
    for (const key of PERMISSIONS_SUB_KEYS) {
      if (!subIds.includes(key)) errors.push(`permissions is missing sub-field: ${key}`);
    }
    for (const key of subIds) {
      if (!PERMISSIONS_SUB_KEYS.includes(key)) errors.push(`permissions has unexpected sub-field: ${key}`);
    }
    if ('categories' in record.permissions && !Array.isArray(record.permissions.categories)) {
      errors.push('permissions.categories must be an array');
    }
    if ('tool_access' in record.permissions && !Array.isArray(record.permissions.tool_access)) {
      errors.push('permissions.tool_access must be an array');
    }
  }

  if (Array.isArray(record.approval_requirements)) {
    record.approval_requirements.forEach((entry, index) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        errors.push(`approval_requirements[${index}] must be an object`);
        return;
      }
      const subIds = Object.keys(entry);
      for (const key of APPROVAL_REQUIREMENT_ENTRY_SUB_KEYS) {
        if (!subIds.includes(key)) errors.push(`approval_requirements[${index}] is missing sub-field: ${key}`);
      }
      for (const key of subIds) {
        if (!APPROVAL_REQUIREMENT_ENTRY_SUB_KEYS.includes(key)) {
          errors.push(`approval_requirements[${index}] has unexpected sub-field: ${key}`);
        }
      }
      if ('requires_human_approval' in entry && typeof entry.requires_human_approval !== 'boolean') {
        errors.push(`approval_requirements[${index}].requires_human_approval must be a boolean`);
      }
    });
  }

  let taskIds = [];
  if (Array.isArray(record.supported_tasks)) {
    taskIds = record.supported_tasks.map((task) => task && task.id);
    record.supported_tasks.forEach((task, index) => {
      const taskResult = validateCapabilityTaskShape(task);
      if (!taskResult.valid) {
        for (const err of taskResult.errors) {
          errors.push(`supported_tasks[${index}] (${(task && task.id) || '?'}): ${err}`);
        }
      }
    });
  }

  if (Array.isArray(record.supported_tasks) && Array.isArray(record.required_tools)) {
    for (const task of record.supported_tasks) {
      if (!task || !Array.isArray(task.tool_ids)) continue;
      for (const toolId of task.tool_ids) {
        if (!record.required_tools.includes(toolId)) {
          errors.push(`supported_tasks[${task.id}] references tool_id '${toolId}' not present in required_tools`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  CAPABILITY_TASK_FIELDS,
  SPECIALIST_CAPABILITY_ENTRY_FIELDS,
  createEmptyCapabilityTask,
  createEmptySpecialistCapabilityEntry,
  validateCapabilityTaskShape,
  validateSpecialistCapabilityEntryShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - specialist capability model (schema only):\n');
  console.log('Specialist capability entry fields:');
  SPECIALIST_CAPABILITY_ENTRY_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nCapability task fields:');
  CAPABILITY_TASK_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty entry:');
  console.log(JSON.stringify(createEmptySpecialistCapabilityEntry('(no id set)'), null, 2));
  console.log('\nNo composition/derivation logic lives here - see agent/core/specialistCapabilityRegistry.js.');
}
