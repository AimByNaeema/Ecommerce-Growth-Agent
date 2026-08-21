'use strict';

// The compact shape of one task's persisted state. This is a schema and a couple of
// pure helpers only - no file I/O, no database, no persistence engine. Actual
// instances of this shape are meant to be saved under memory/state/ (see
// agent/core/agentContract.js's save_state stage) once persistence is implemented in
// a later, explicitly-scoped prompt.
//
// Fields hold compact summaries and references, never raw dumps:
// - relevant_configuration references configuration/business.yaml fields, not a copy
//   of the file.
// - selected_research references research/ entries (ids/paths), not their full text.
// - findings/decisions are short records, not transcripts of how they were reached.
// This model never stores conversation turns or message history.

const TASK_STATUSES = ['not_started', 'in_progress', 'blocked', 'complete', 'failed'];
const VERIFICATION_STATUSES = ['unverified', 'passed', 'failed'];

const STATE_FIELDS = [
  {
    id: 'current_objective',
    title: 'Current objective',
    type: 'string',
    description: "The task's objective in the agent's own words - a compact restatement, not the raw conversation.",
  },
  {
    id: 'task_status',
    title: 'Task status',
    type: `enum: ${TASK_STATUSES.join(' | ')}`,
    description: "Where the task currently stands.",
  },
  {
    id: 'relevant_configuration',
    title: 'Relevant configuration',
    type: 'array',
    description: 'References into configuration/business.yaml (e.g. field names) relevant to this task - not a copy of the whole file.',
  },
  {
    id: 'selected_research',
    title: 'Selected research',
    type: 'array',
    description: 'References (ids/paths) into research/ selected as relevant - not the full research database.',
  },
  {
    id: 'findings',
    title: 'Findings',
    type: 'array',
    description: 'Compact findings produced during the task - short summaries, not raw source dumps.',
  },
  {
    id: 'decisions',
    title: 'Decisions',
    type: 'array',
    description: 'Decisions made and why - compact records, not a transcript of how they were reached.',
  },
  {
    id: 'pending_work',
    title: 'Pending work',
    type: 'array',
    description: 'Steps identified but not yet started.',
  },
  {
    id: 'completed_work',
    title: 'Completed work',
    type: 'array',
    description: 'Steps finished successfully.',
  },
  {
    id: 'failed_work',
    title: 'Failed work',
    type: 'array',
    description: 'Steps that failed, with the confirmed reason.',
  },
  {
    id: 'verification_status',
    title: 'Verification status',
    type: `enum: ${VERIFICATION_STATUSES.join(' | ')}`,
    description: "Whether the task's results have been verified.",
  },
  {
    id: 'approvals',
    title: 'Approvals',
    type: 'array',
    description: 'References to approval requests/records in approvals/ relevant to this task.',
  },
];

const ARRAY_FIELD_IDS = STATE_FIELDS.filter((field) => field.type === 'array').map((field) => field.id);

// Returns a blank state object conforming to STATE_FIELDS. No task/business data -
// callers fill it in.
function createEmptyState(objective = '') {
  return {
    current_objective: objective,
    task_status: 'not_started',
    relevant_configuration: [],
    selected_research: [],
    findings: [],
    decisions: [],
    pending_work: [],
    completed_work: [],
    failed_work: [],
    verification_status: 'unverified',
    approvals: [],
  };
}

// Checks that a state object has exactly the expected keys, with the expected basic
// shapes. Does not guess or fill in anything missing - only reports.
function validateStateShape(state) {
  const errors = [];

  if (typeof state !== 'object' || state === null || Array.isArray(state)) {
    return { valid: false, errors: ['state must be a plain object'] };
  }

  const expectedIds = STATE_FIELDS.map((field) => field.id);
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

  if ('task_status' in state && !TASK_STATUSES.includes(state.task_status)) {
    errors.push(`task_status must be one of: ${TASK_STATUSES.join(', ')}`);
  }
  if ('verification_status' in state && !VERIFICATION_STATUSES.includes(state.verification_status)) {
    errors.push(`verification_status must be one of: ${VERIFICATION_STATUSES.join(', ')}`);
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  STATE_FIELDS,
  TASK_STATUSES,
  VERIFICATION_STATUSES,
  createEmptyState,
  validateStateShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - compact state model (schema only):\n');
  STATE_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty state:');
  console.log(JSON.stringify(createEmptyState('(no objective set)'), null, 2));
}
