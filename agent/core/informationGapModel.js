'use strict';

// The shape of ONE information-gap opportunity: a real question people are asking,
// what evidence supports that it is really asked, how well competitors and our own site
// answer it, what specifically is missing, and a deterministic, explainable priority
// score. Schema and pure helpers only - no discovery, clustering, or scoring logic
// (that is agent/core/informationGapEngine.js), matching every other *Model.js file in
// agent/core/ and mirroring agent/core/seoResearchModel.js's design exactly.
//
// THE POINT OF THIS SCHEMA IS PROVENANCE HONESTY. `evidence_strength` is the field the
// whole capability turns on: a question directly OBSERVED in a real source is not the
// same claim as one INFERRED from related evidence, and neither is the same as one a
// model simply produced. Keeping those three apart in the schema itself is what makes
// it structurally impossible to present a model-generated question as a verified market
// question - see EVIDENCE_STRENGTHS below and the engine's own status rules.
//
// confidence-style enums are NOT redefined here: `evidence_sources` entries carry their
// own caller-supplied references, and the record's overall trustworthiness is expressed
// through evidence_strength + status rather than a parallel confidence scale, so this
// schema adds no competing vocabulary to agent/core/researchRecordModel.js's existing
// CONFIDENCE_LEVELS/RESEARCH_VERIFICATION_STATUSES (which the wrapping
// agent/core/seoAgentResultModel.js envelope already carries for the result as a whole).

// How a question was arrived at. Ordered weakest-last on purpose - the engine compares
// by index to pick a cluster's canonical question.
const EVIDENCE_STRENGTHS = ['observed', 'inferred', 'model_generated'];

// What kind of question this is - used to choose a recommended content type, never to
// assert anything about demand.
const QUESTION_TYPES = [
  'informational',
  'comparison',
  'buying',
  'use_case',
  'troubleshooting',
  'product_specific',
  'unclassified',
];

// The specific kind of information gap identified. `null` is also valid and means "no
// gap found" - see GAP_STATUSES' 'no_gap'.
const GAP_TYPES = [
  'missing_question',
  'weak_answer',
  'incomplete_answer',
  'unclear_answer',
  'outdated_answer',
  'poor_product_context',
  'missing_comparison',
  'missing_use_case',
  'missing_troubleshooting',
  'missing_buying_information',
];

// The record's overall disposition.
//   'opportunity' - real evidence, real competitor coverage data, a real identified gap.
//   'review'      - the required REVIEW/uncertainty status: evidence is insufficient,
//                   competitor coverage evidence is too thin to claim a gap, or
//                   ownership/policy is ambiguous. Never an assertion either way.
//   'no_gap'      - our own site already answers this and competitors cover it well.
// Lowercase to match every other status enum in this project (tools' success/partial/
// empty/failed, researchRecordModel.js's unverified/verified/outdated).
const GAP_STATUSES = ['opportunity', 'review', 'no_gap'];

const INFORMATION_GAP_FIELDS = [
  {
    id: 'question',
    title: 'Question',
    type: 'string',
    description: 'The question as it was actually observed or supplied - the caller\'s own wording, never rewritten.',
  },
  {
    id: 'normalized_question',
    title: 'Normalized question',
    type: 'string',
    description: 'A deterministic normalization of the question (lowercased, punctuation and filler stripped) used for duplicate detection and clustering.',
  },
  {
    id: 'question_type',
    title: 'Question type',
    type: `enum: ${QUESTION_TYPES.join(' | ')}`,
    description: 'What kind of question this is - only ever what the caller asserted, defaulting to unclassified. Never inferred from the wording here.',
  },
  {
    id: 'clustered_variants',
    title: 'Clustered variants',
    type: 'array',
    description: 'The other caller-supplied phrasings that normalized/clustered into this same question - kept rather than silently discarded, so a human can see what was merged.',
  },
  {
    id: 'evidence_sources',
    title: 'Evidence sources',
    type: 'array',
    description: 'Where the evidence that people really ask this came from - each entry names its signal kind (e.g. competitor FAQ, review question, first-party site search) and its own reference. Empty means there is no evidence at all.',
  },
  {
    id: 'evidence_strength',
    title: 'Evidence strength',
    type: `enum: ${EVIDENCE_STRENGTHS.join(' | ')}`,
    description: 'Whether this question was directly observed in a real source, inferred from related evidence, or produced with no supporting observation at all. A model_generated question is never presentable as a verified market question.',
  },
  {
    id: 'competitor_coverage',
    title: 'Competitor coverage',
    type: 'object',
    description: 'How the observed competitors cover this question: how many were checked, how many answer it, and the BEST answer quality any of them achieved. Counts and an enum only - never competitor wording. Best, not worst, because the opportunity is only real where the best answer a customer can already find is still inadequate.',
  },
  {
    id: 'current_site_coverage',
    title: 'Current site coverage',
    type: 'object',
    description: 'Whether our own site already answers this question, and where - so an already-answered question is not reported as a gap.',
  },
  {
    id: 'identified_gap',
    title: 'Identified gap',
    type: 'string',
    description: 'A plain statement of what specific information is missing. Empty when no gap was identified.',
  },
  {
    id: 'gap_type',
    title: 'Gap type',
    type: `enum: ${GAP_TYPES.join(' | ')} | null`,
    description: 'The classified kind of gap, or null when no gap was identified or the evidence was too thin to classify one.',
  },
  {
    id: 'opportunity_score',
    title: 'Opportunity score',
    type: 'number',
    description: 'A deterministic 0-100 priority score derived only from supplied evidence. Identical input always produces an identical score. Never a demand or volume estimate.',
  },
  {
    id: 'score_reasons',
    title: 'Score reasons',
    type: 'array',
    description: 'One entry per scoring component naming the evidence it used - or explicitly naming the evidence it lacked - so the score is always explainable to a human or another system.',
  },
  {
    id: 'recommended_content_type',
    title: 'Recommended content type',
    type: 'string',
    description: 'What kind of content would answer this question (e.g. FAQ entry, buying guide, comparison page). A recommendation for the existing content-generation capability - no content is produced here.',
  },
  {
    id: 'recommended_target_page',
    title: 'Recommended target page',
    type: 'string',
    description: 'Which of our own pages this should live on or be added to - only ever a caller-supplied page reference, never an invented URL.',
  },
  {
    id: 'suggested_title',
    title: 'Suggested title',
    type: 'string',
    description: 'A suggested title built ONLY from the question itself and caller-supplied product context - never from competitor wording.',
  },
  {
    id: 'suggested_outline',
    title: 'Suggested outline',
    type: 'array',
    description: 'Suggested sections for whoever writes the content, built ONLY from the question, the gap type, and caller-supplied product context - never from competitor wording.',
  },
  {
    id: 'recommended_internal_links',
    title: 'Recommended internal links',
    type: 'array',
    description: 'Caller-supplied internal link targets worth linking from this content - relayed, never invented.',
  },
  {
    id: 'status',
    title: 'Status',
    type: `enum: ${GAP_STATUSES.join(' | ')}`,
    description: 'This record\'s disposition: a real opportunity, needs human review because the evidence is insufficient or ambiguous, or no gap at all.',
  },
  {
    id: 'research_date',
    title: 'Research date',
    type: 'string',
    description: 'When this record was produced (ISO date).',
  },
];

const ARRAY_FIELD_IDS = INFORMATION_GAP_FIELDS.filter((field) => field.type === 'array').map(
  (field) => field.id
);

// Returns a blank information-gap record conforming to INFORMATION_GAP_FIELDS. No
// analysis - agent/core/informationGapEngine.js fills it in. Starts at the most
// cautious possible position: no evidence, model_generated strength, no gap, zero
// score, and 'review' status - so a record that is never populated can never read as a
// verified opportunity.
function createEmptyInformationGapRecord(question = '') {
  return {
    question,
    normalized_question: '',
    question_type: 'unclassified',
    clustered_variants: [],
    evidence_sources: [],
    evidence_strength: 'model_generated',
    competitor_coverage: {
      competitors_checked: 0,
      competitors_answering: 0,
      best_answer_quality: null,
    },
    current_site_coverage: {
      covered: false,
      coverage_quality: null,
      pages: [],
    },
    identified_gap: '',
    gap_type: null,
    opportunity_score: 0,
    score_reasons: [],
    recommended_content_type: '',
    recommended_target_page: '',
    suggested_title: '',
    suggested_outline: [],
    recommended_internal_links: [],
    status: 'review',
    research_date: '',
  };
}

// Checks that a record has exactly the expected keys with the expected basic shapes.
// Does not guess or fill in anything missing - only reports, exactly like every other
// validate*Shape function in agent/core/.
function validateInformationGapShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = INFORMATION_GAP_FIELDS.map((field) => field.id);
  const actualIds = Object.keys(record);

  for (const id of expectedIds) {
    if (!actualIds.includes(id)) errors.push(`missing field: ${id}`);
  }
  for (const id of actualIds) {
    if (!expectedIds.includes(id)) errors.push(`unexpected field: ${id}`);
  }

  for (const id of ARRAY_FIELD_IDS) {
    if (id in record && !Array.isArray(record[id])) errors.push(`${id} must be an array`);
  }

  if ('question' in record && (typeof record.question !== 'string' || record.question.trim() === '')) {
    errors.push('question must be a non-empty string');
  }
  if ('evidence_strength' in record && !EVIDENCE_STRENGTHS.includes(record.evidence_strength)) {
    errors.push(`evidence_strength must be one of: ${EVIDENCE_STRENGTHS.join(', ')}`);
  }
  if ('question_type' in record && !QUESTION_TYPES.includes(record.question_type)) {
    errors.push(`question_type must be one of: ${QUESTION_TYPES.join(', ')}`);
  }
  // null is deliberately valid - it means "no gap identified", which is a real and
  // important outcome, not a missing value.
  if ('gap_type' in record && record.gap_type !== null && !GAP_TYPES.includes(record.gap_type)) {
    errors.push(`gap_type must be null or one of: ${GAP_TYPES.join(', ')}`);
  }
  if ('status' in record && !GAP_STATUSES.includes(record.status)) {
    errors.push(`status must be one of: ${GAP_STATUSES.join(', ')}`);
  }
  if (
    'opportunity_score' in record &&
    (typeof record.opportunity_score !== 'number' ||
      Number.isNaN(record.opportunity_score) ||
      record.opportunity_score < 0 ||
      record.opportunity_score > 100)
  ) {
    errors.push('opportunity_score must be a number between 0 and 100');
  }
  for (const id of ['competitor_coverage', 'current_site_coverage']) {
    if (id in record && (typeof record[id] !== 'object' || record[id] === null || Array.isArray(record[id]))) {
      errors.push(`${id} must be a plain object`);
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  EVIDENCE_STRENGTHS,
  QUESTION_TYPES,
  GAP_TYPES,
  GAP_STATUSES,
  INFORMATION_GAP_FIELDS,
  createEmptyInformationGapRecord,
  validateInformationGapShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - information gap model (schema only):\n');
  INFORMATION_GAP_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyInformationGapRecord('(no question set)'), null, 2));
}
