'use strict';

const { STATE_FIELDS } = require('./stateModel');

// Memory rules for the ONE agent: what memory must satisfy, what it should
// prioritize saving, and what it must never save. Rules only - no decision engine,
// no automatic saving or pruning. These rules are enforced once the save_state stage
// (agent/core/agentContract.js) and real persistence are implemented in a later,
// explicitly-scoped prompt.

const MEMORY_QUALITIES = [
  {
    id: 'relevant',
    description:
      'Only saved if it pertains to the business or objective it is attached to - not generic or unrelated content.',
  },
  {
    id: 'compact',
    description:
      'Saved as a summary or reference, never a raw/verbatim dump (see agent/core/stateModel.js field descriptions).',
  },
  {
    id: 'structured',
    description:
      'Saved using the defined state shape (agent/core/stateModel.js), not free-form text blobs.',
  },
  {
    id: 'retrievable',
    description:
      'Saved under its correct context boundary (agent/core/contextBoundaries.js) so it can be looked up by business and task without scanning everything.',
  },
  {
    id: 'safe',
    description:
      'Never includes secrets or credentials, and stays scoped to the business it belongs to - never leaks across businesses (mirrors the configuration/business.yaml and data/business/ boundaries).',
  },
];

// Priority order for what gets saved, each mapped (where one exists) to the
// agent/core/stateModel.js field it belongs in.
const MEMORY_PRIORITIES = [
  {
    id: 'reusable_findings',
    stateField: 'findings',
    description: 'Findings likely to matter again, not one-off observations.',
  },
  {
    id: 'important_decisions',
    stateField: 'decisions',
    description: 'Decisions that shaped the outcome and why, not every option considered.',
  },
  {
    id: 'business_configuration',
    stateField: 'relevant_configuration',
    description: 'The subset of configuration/business.yaml actually used, not the whole file.',
  },
  {
    id: 'research_summaries',
    stateField: 'selected_research',
    description: 'Summaries of research/ entries actually used, not the raw research.',
  },
  {
    id: 'completed_tasks',
    stateField: 'completed_work',
    description: 'A compact record that a task completed, not the steps it took to get there.',
  },
  {
    id: 'useful_historical_context',
    stateField: null,
    description:
      'Cross-task patterns worth remembering for this business - not tied to a single state field, since it may span multiple past task states.',
  },
];

// What must never be saved to memory/state/, regardless of the above.
const MEMORY_EXCLUSIONS = [
  {
    id: 'temporary_noise',
    description:
      'Intermediate scratch or working steps belong in data/tasks/ (disposable) and must not be promoted to memory/state/ (durable).',
  },
  {
    id: 'full_conversation_by_default',
    description:
      'Raw conversation transcripts or message logs are not saved by default - only a compact objective restatement (current_objective) is kept, per agent/core/stateModel.js.',
  },
];

function getMemoryRules() {
  return { qualities: MEMORY_QUALITIES, priorities: MEMORY_PRIORITIES, exclusions: MEMORY_EXCLUSIONS };
}

module.exports = { MEMORY_QUALITIES, MEMORY_PRIORITIES, MEMORY_EXCLUSIONS, getMemoryRules };

if (require.main === module) {
  const stateFieldIds = STATE_FIELDS.map((field) => field.id);
  console.log('Smart E-Commerce Growth AI Agent - memory rules:\n');

  console.log('Memory must be:');
  MEMORY_QUALITIES.forEach((quality, index) => {
    console.log(`${index + 1}. [${quality.id}] ${quality.description}`);
  });

  console.log('\nPrioritize saving:');
  MEMORY_PRIORITIES.forEach((priority, index) => {
    const fieldNote = priority.stateField
      ? `state field: ${priority.stateField}`
      : 'no single state field';
    console.log(`${index + 1}. [${priority.id}] (${fieldNote})`);
    console.log(`   ${priority.description}`);
  });

  console.log('\nNever save by default:');
  MEMORY_EXCLUSIONS.forEach((exclusion, index) => {
    console.log(`${index + 1}. [${exclusion.id}] ${exclusion.description}`);
  });

  const unknownFields = MEMORY_PRIORITIES.filter(
    (p) => p.stateField && !stateFieldIds.includes(p.stateField)
  );
  if (unknownFields.length > 0) {
    console.error('\nWARNING: priorities reference unknown state fields:', unknownFields.map((p) => p.id));
  }
}
