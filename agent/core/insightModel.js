'use strict';

// The shape of one analytics insight record - the concrete, per-metric output of
// agent/core/insightEngine.js's significance detection, composed and honesty-graded by
// agent/core/analyticsAgent.js's `insights` capability. Schema and a couple of pure
// helpers only - no significance detection, no arithmetic (that belongs to
// insightEngine.js) and no synthesis of a cause/opportunity/recommendation (those are
// always caller-supplied hypotheses, never invented here or anywhere in this
// deterministic, evidence-only architecture).
//
// Maps directly onto workflows/analyticsInsightWorkflow.js's own stage/statement-type
// taxonomy - this record is not a replacement for that workflow, it is the concrete
// shape one pass through it produces:
//   current_state  <- DATA/FINDING stage (observed_fact / calculated_result)
//   comparison     <- FINDING stage (calculated_result) - a defined arithmetic
//                     comparison against a baseline, computed by
//                     agent/core/insightEngine.js from caller-supplied raw values.
//   possible_cause <- INTERPRETATION/hypothesis - an unproven possible explanation,
//                     never presented as a confirmed cause.
//   opportunity    <- OPPORTUNITY stage (hypothesis)
//   recommendation <- RECOMMENDATION stage
//   confidence     <- caller-asserted only, subject to the causation-honesty guard
//                     below and the standard verified-without-evidence guard every
//                     other module in this project already applies.
//   evidence       <- what actually backs this insight (and specifically what backs
//                     possible_cause, if anything does)
//
// CAUSATION HONESTY (do not state correlation as causation without evidence): a
// `possible_cause` is always labeled as a possible cause, never a confirmed one - this
// schema has no separate "confirmed_cause" field, on purpose. agent/core/analyticsAgent.js's
// analyzeInsights() enforces this structurally: a possible_cause stated with an empty
// `evidence` array can never carry 'high' confidence - it is capped at 'medium', with
// an explicit limitation naming the downgrade. This is a presence-only guard (it
// checks whether evidence was supplied, not whether that evidence actually supports
// the causal claim - this deterministic system has no way to judge that) - the same
// honest limit every other confidence/verification guard in this project already
// accepts (see agent/core/researchAgent.js's verified-without-evidence downgrade).
//
// `confidence` and `verification_status` reuse agent/core/researchRecordModel.js's
// existing enums rather than redefining them, following the same cross-schema reuse
// precedent as every other model in this project.

const { CONFIDENCE_LEVELS, RESEARCH_VERIFICATION_STATUSES } = require('./researchRecordModel');

const INSIGHT_FIELDS = [
  {
    id: 'metric',
    title: 'Metric',
    type: 'string',
    description: 'Which metric this insight is about (e.g. total_revenue) - never invented, always caller-named.',
  },
  {
    id: 'current_state',
    title: 'Current state',
    type: 'string',
    description: 'A description of the metric\'s current value - an observed fact/calculated result, not a judgment.',
  },
  {
    id: 'comparison',
    title: 'Comparison',
    type: 'string',
    description: 'How the current value compares to a baseline (e.g. prior period, target) - a calculated result, computed by agent/core/insightEngine.js from caller-supplied raw values.',
  },
  {
    id: 'possible_cause',
    title: 'Possible cause',
    type: 'string',
    description: 'An unproven, possible explanation for the comparison - a hypothesis, never presented as a confirmed cause. Requires supporting evidence to be trusted at more than medium confidence (see module header).',
  },
  {
    id: 'opportunity',
    title: 'Opportunity',
    type: 'string',
    description: 'A possible growth/optimization opportunity this insight suggests - a hypothesis, not a guarantee.',
  },
  {
    id: 'recommendation',
    title: 'Recommendation',
    type: 'string',
    description: 'A suggested action for a human to consider - a suggestion only; nothing here executes it.',
  },
  {
    id: 'confidence',
    title: 'Confidence',
    type: `enum: ${CONFIDENCE_LEVELS.join(' | ')}`,
    description: 'How much this insight is trusted - only ever what the caller explicitly asserted, then honesty-graded (see module header\'s causation guard).',
  },
  {
    id: 'evidence',
    title: 'Evidence',
    type: 'array',
    description: 'Real data backing this insight - especially whatever backs possible_cause, if anything does.',
  },
  {
    id: 'verification_status',
    title: 'Verification status',
    type: `enum: ${RESEARCH_VERIFICATION_STATUSES.join(' | ')}`,
    description: 'Whether this insight has been checked against real, configured data.',
  },
];

const ARRAY_FIELD_IDS = INSIGHT_FIELDS.filter((field) => field.type === 'array').map((field) => field.id);

// Returns a blank insight record conforming to INSIGHT_FIELDS. No real comparison,
// cause, opportunity, or recommendation - callers (agent/core/analyticsAgent.js) fill
// it in from caller-supplied input and agent/core/insightEngine.js's computed
// comparison.
function createEmptyInsightRecord(metric = '') {
  return {
    metric,
    current_state: '',
    comparison: '',
    possible_cause: '',
    opportunity: '',
    recommendation: '',
    confidence: 'unassessed',
    evidence: [],
    verification_status: 'unverified',
  };
}

// Checks that an insight record has exactly the expected keys, with the expected
// basic shapes. Does not guess or fill in anything missing - only reports.
function validateInsightShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = INSIGHT_FIELDS.map((field) => field.id);
  const actualIds = Object.keys(record);

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
    if (id in record && !Array.isArray(record[id])) {
      errors.push(`${id} must be an array`);
    }
  }

  if ('confidence' in record && !CONFIDENCE_LEVELS.includes(record.confidence)) {
    errors.push(`confidence must be one of: ${CONFIDENCE_LEVELS.join(', ')}`);
  }
  if (
    'verification_status' in record &&
    !RESEARCH_VERIFICATION_STATUSES.includes(record.verification_status)
  ) {
    errors.push(`verification_status must be one of: ${RESEARCH_VERIFICATION_STATUSES.join(', ')}`);
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  INSIGHT_FIELDS,
  createEmptyInsightRecord,
  validateInsightShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - insight model (schema only):\n');
  INSIGHT_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyInsightRecord('(no metric set)'), null, 2));
  console.log('\nA possible_cause is never a confirmed cause - correlation is never asserted as causation without evidence (see agent/core/analyticsAgent.js\'s analyzeInsights()).');
}
