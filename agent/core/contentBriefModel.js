'use strict';

// The shape of one SEO content brief and its generated draft - the stage AFTER the
// Information Gap Finder: a validated information-gap opportunity becomes a structured
// brief, and (only when the evidence justifies it) a content draft for a human to
// review. Schema and pure helpers only, matching every other *Model.js in agent/core/.
//
// CONSUMES THE EXISTING GAP CONTRACT. Its input is an
// agent/core/informationGapModel.js record exactly as findInformationGaps() produces
// one - there is deliberately no second gap schema here, and none of that model's
// fields are redefined.
//
// WHY THREE STATUSES. A brief that reads "ready" when its evidence does not support the
// content is worse than no brief at all, because a human downstream will trust it:
//   'ready'   - the opportunity is genuinely evidenced, a real gap was identified, and
//               the generated draft passed every deterministic post-check.
//   'review'  - a human must look before this goes further: the gap opportunity was
//               itself unresolved, or the draft made a claim the supplied evidence
//               does not support. A brief still exists; content may or may not.
//   'blocked' - content must NOT be written at all: the question was never really
//               evidenced (model_generated), or our own site already answers it. No
//               model call is made, so a blocked opportunity costs nothing.
// review_reasons always names WHY, per reason - never a bare status.
//
// NOTHING HERE PUBLISHES. This schema is the end of the pipeline stage: brief plus
// draft. Compliance, human approval, and publishing are later, separate stages, and no
// field here carries a destination, schedule, or publish flag of any kind.

const CONTENT_BRIEF_STATUSES = ['ready', 'review', 'blocked'];

// What kind of content answers this question. Sourced from the gap record's own
// recommended_content_type rather than re-decided here - the Gap Finder already mapped
// question type to content type, and re-deriving it would be a second, drifting copy.
const SUPPORTED_CONTENT_TYPES = [
  'FAQ entry',
  'informational article',
  'buying guide',
  'comparison page',
  'use-case guide',
  'troubleshooting guide',
  'product page section',
];

const CONTENT_BRIEF_FIELDS = [
  { id: 'target_question', title: 'Target question', type: 'string', description: 'The real question this content must answer - carried verbatim from the gap opportunity, never rewritten.' },
  { id: 'content_type', title: 'Content type', type: 'string', description: "The gap opportunity's own recommended_content_type, preserved rather than re-decided here." },
  { id: 'search_intent', title: 'Search intent', type: 'string', description: "What the searcher is trying to do - derived deterministically from the gap's question type, or relayed from the caller. SEO's own concern, never a marketing or campaign judgment." },
  { id: 'target_page', title: 'Target page', type: 'string', description: 'Which of our own pages this belongs on - only ever the reference the opportunity already carried; never an invented URL.' },
  { id: 'suggested_title', title: 'Suggested title', type: 'string', description: "The opportunity's own suggested title, built from the question and caller product context - never from competitor wording." },
  { id: 'content_angle', title: 'Content angle', type: 'string', description: 'How to approach the answer, derived deterministically from the identified gap type - what is missing dictates the angle.' },
  { id: 'audience_problem', title: 'Audience problem', type: 'string', description: 'The customer problem behind the question, stated from the question and gap itself - never an invented persona or segment claim.' },
  { id: 'key_information_to_cover', title: 'Key information to cover', type: 'array', description: 'The specific points the content must cover to close the gap. Derived from the gap type and the opportunity\'s own outline - never from competitor text.' },
  { id: 'recommended_outline', title: 'Recommended outline', type: 'array', description: "The opportunity's own suggested outline, preserved." },
  { id: 'evidence', title: 'Evidence', type: 'array', description: 'The provenance carried forward from the opportunity: where the question was actually observed. Empty means the question was never evidenced.' },
  { id: 'competitor_gap_summary', title: 'Competitor gap summary', type: 'string', description: 'A COUNT-based statement of how well competitors cover this question. Built from the opportunity\'s coverage counts only - it reproduces no competitor wording, title, or claim.' },
  { id: 'internal_link_opportunities', title: 'Internal link opportunities', type: 'array', description: "The opportunity's own recommended internal links, relayed - never invented." },
  { id: 'differentiation_points', title: 'Differentiation points', type: 'array', description: 'Caller-supplied points about what our answer can offer that others do not. Empty when the caller supplied none - never inferred.' },
  { id: 'status', title: 'Status', type: `enum: ${CONTENT_BRIEF_STATUSES.join(' | ')}`, description: 'Whether this brief is ready to act on, needs human review, or is blocked from becoming content at all.' },
];

const CONTENT_GENERATION_RESULT_FIELDS = [
  { id: 'opportunity_reference', title: 'Opportunity reference', type: 'string', description: 'Which gap opportunity this came from - the caller\'s own id where supplied, otherwise the opportunity\'s normalized question.' },
  { id: 'brief', title: 'Brief', type: 'object', description: 'The structured content brief (CONTENT_BRIEF_FIELDS).' },
  { id: 'generated_content', title: 'Generated content', type: 'string', description: 'The drafted content. Empty whenever status is blocked, or whenever the opportunity was not evidenced enough to justify generating anything - never a fabricated draft to fill the field.' },
  { id: 'content_type', title: 'Content type', type: 'string', description: "The brief's content type, surfaced at the top level for the downstream approval/publishing stages." },
  { id: 'target_question', title: 'Target question', type: 'string', description: 'The real question this content answers.' },
  { id: 'target_page', title: 'Target page', type: 'string', description: 'The page this content is intended for. Intent only - nothing here publishes to it.' },
  { id: 'evidence', title: 'Evidence', type: 'array', description: 'The provenance carried forward from the gap opportunity.' },
  { id: 'status', title: 'Status', type: `enum: ${CONTENT_BRIEF_STATUSES.join(' | ')}`, description: 'ready, review, or blocked - never ready when required evidence is missing or a post-check failed.' },
  { id: 'review_reasons', title: 'Review reasons', type: 'array', description: 'One entry per reason this is not ready, naming exactly what is missing or unsupported. Empty only when status is ready.' },
  { id: 'limitations', title: 'Limitations', type: 'array', description: 'Honest caveats about this result - always populated, never omitted.' },
];

const BRIEF_ARRAY_FIELDS = CONTENT_BRIEF_FIELDS.filter((f) => f.type === 'array').map((f) => f.id);
const RESULT_ARRAY_FIELDS = CONTENT_GENERATION_RESULT_FIELDS.filter((f) => f.type === 'array').map((f) => f.id);

function createEmptyContentBrief(targetQuestion = '') {
  return {
    target_question: targetQuestion,
    content_type: '',
    search_intent: '',
    target_page: '',
    suggested_title: '',
    content_angle: '',
    audience_problem: '',
    key_information_to_cover: [],
    recommended_outline: [],
    evidence: [],
    competitor_gap_summary: '',
    internal_link_opportunities: [],
    differentiation_points: [],
    // The cautious default: a brief that is never populated cannot read as actionable.
    status: 'review',
  };
}

function createEmptyContentGenerationResult(opportunityReference = '') {
  return {
    opportunity_reference: opportunityReference,
    brief: createEmptyContentBrief(),
    generated_content: '',
    content_type: '',
    target_question: '',
    target_page: '',
    evidence: [],
    status: 'review',
    review_reasons: [],
    limitations: [],
  };
}

function validateShapeAgainst(record, fields, arrayFieldIds, label) {
  const errors = [];
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: [`${label} must be a plain object`] };
  }
  const expectedIds = fields.map((field) => field.id);
  const actualIds = Object.keys(record);
  for (const id of expectedIds) {
    if (!actualIds.includes(id)) errors.push(`missing field: ${id}`);
  }
  for (const id of actualIds) {
    if (!expectedIds.includes(id)) errors.push(`unexpected field: ${id}`);
  }
  for (const id of arrayFieldIds) {
    if (id in record && !Array.isArray(record[id])) errors.push(`${id} must be an array`);
  }
  if ('status' in record && !CONTENT_BRIEF_STATUSES.includes(record.status)) {
    errors.push(`status must be one of: ${CONTENT_BRIEF_STATUSES.join(', ')}`);
  }
  return { valid: errors.length === 0, errors };
}

function validateContentBriefShape(record) {
  return validateShapeAgainst(record, CONTENT_BRIEF_FIELDS, BRIEF_ARRAY_FIELDS, 'brief');
}

function validateContentGenerationResultShape(record) {
  const result = validateShapeAgainst(record, CONTENT_GENERATION_RESULT_FIELDS, RESULT_ARRAY_FIELDS, 'result');
  const errors = [...result.errors];

  if (record && typeof record === 'object' && !Array.isArray(record)) {
    if ('brief' in record) {
      const briefValidation = validateContentBriefShape(record.brief);
      for (const error of briefValidation.errors) errors.push(`brief: ${error}`);
    }
    // The honesty invariant, enforced by the schema itself rather than left to
    // convention: 'ready' must never coexist with an outstanding review reason, and a
    // non-ready result must always say why.
    if (record.status === 'ready' && Array.isArray(record.review_reasons) && record.review_reasons.length > 0) {
      errors.push('status cannot be ready while review_reasons is non-empty');
    }
    if (record.status !== 'ready' && Array.isArray(record.review_reasons) && record.review_reasons.length === 0) {
      errors.push(`status '${record.status}' requires at least one review reason`);
    }
    // Blocked means no content was written at all - not content that is merely hidden.
    if (record.status === 'blocked' && typeof record.generated_content === 'string' && record.generated_content !== '') {
      errors.push('a blocked result must not carry generated content');
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  CONTENT_BRIEF_STATUSES,
  SUPPORTED_CONTENT_TYPES,
  CONTENT_BRIEF_FIELDS,
  CONTENT_GENERATION_RESULT_FIELDS,
  createEmptyContentBrief,
  createEmptyContentGenerationResult,
  validateContentBriefShape,
  validateContentGenerationResultShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - SEO content brief model (schema only):\n');
  console.log('Brief fields:');
  CONTENT_BRIEF_FIELDS.forEach((field, index) => console.log(`  ${index + 1}. [${field.id}] ${field.title}`));
  console.log('\nResult fields:');
  CONTENT_GENERATION_RESULT_FIELDS.forEach((field, index) => console.log(`  ${index + 1}. [${field.id}] ${field.title}`));
  console.log('\nExample empty result:');
  console.log(JSON.stringify(createEmptyContentGenerationResult('(no opportunity set)'), null, 2));
}
