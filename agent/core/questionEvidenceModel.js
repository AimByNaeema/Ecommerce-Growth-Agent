'use strict';

// The shape of ONE discovered market question and the evidence that it is really
// asked - the upstream input to the existing Information Gap Finder
// (agent/core/informationGapModel.js / informationGapEngine.js, both unchanged by this
// module). Schema and pure helpers only, matching every other *Model.js in agent/core/.
//
// WHY PROVENANCE LIVES IN AN `observations` ARRAY RATHER THAN FLAT FIELDS: the same
// question genuinely turns up in more than one place - "how long does X last?" can
// appear in a competitor FAQ, a public Q&A page, and a forum thread. Collapsing those
// into one flat source_url would silently throw away real corroborating evidence, and
// keeping them as three unrelated records would triple-count one question. So a record
// carries ONE question and EVERY observation of it, each observation retaining its own
// full provenance (evidence_kind, source_type, source_reference, source_url,
// collected_at, original_observation). Merging never destroys provenance.
//
// evidence_strength reuses agent/core/informationGapModel.js's EVIDENCE_STRENGTHS
// verbatim rather than defining a competing scale - this record's whole purpose is to
// feed that model, and two different vocabularies for the same distinction is exactly
// how a model_generated question would eventually get laundered into an observed one.
//
// NO DEMAND FIELD IS EVER INVENTED. There is no search_volume, monthly_searches,
// traffic, CTR, or ranking field in this schema at all, and `demand_measured` exists
// precisely so a consumer is told explicitly that demand was NOT measured rather than
// being left to assume it from a missing field.

const { EVIDENCE_STRENGTHS } = require('./informationGapModel');

// What kind of signal an observation is. Mirrors the vocabulary the Information Gap
// Finder already accepts (see informationGapEngine.js's OBSERVED_SIGNAL_KINDS /
// INFERRED_SIGNAL_KINDS) so a record maps into it without translation guesswork.
const EVIDENCE_KINDS = [
  'search_suggestion',
  'people_also_ask',
  'related_search',
  'public_qa',
  'public_forum_question',
  'competitor_question',
  'existing_research',
  'other_observed',
];

// Which of those kinds this project can ACTUALLY produce today, and which it cannot.
// This is deliberately explicit rather than implied by what happens to be implemented:
// an unsupported source must be visibly unsupported, never quietly absent.
//
// Supported: page-level question evidence reached through Anthropic's hosted web_search
// tool (agent/core/claudeClient.js's `tools` passthrough - the project's only existing
// public-web capability), plus research this project already collected itself.
//
// Unsupported: search_suggestion, people_also_ask and related_search are SERP FEATURES,
// not pages. No autocomplete/SERP API client exists in this project, and web_search
// returns pages rather than the suggestion or People-Also-Ask boxes themselves - so
// there is no honest way to attest that a question came from one. Claiming otherwise
// would be manufacturing provenance, which is the one thing this layer exists to
// prevent. They stay listed here so a future, properly-scoped integration has a name to
// fill in; nothing produces them today.
const SUPPORTED_EVIDENCE_KINDS = [
  'public_qa',
  'public_forum_question',
  'competitor_question',
  'other_observed',
  'existing_research',
];

const UNSUPPORTED_EVIDENCE_KINDS = EVIDENCE_KINDS.filter(
  (kind) => !SUPPORTED_EVIDENCE_KINDS.includes(kind)
);

// Where an observation physically came from - the acquisition path, distinct from the
// evidence_kind (what the signal IS).
const SOURCE_TYPES = ['web_search_result', 'existing_research_output'];

const QUESTION_EVIDENCE_FIELDS = [
  {
    id: 'question',
    title: 'Question',
    type: 'string',
    description: 'The question exactly as first observed - never rewritten, reworded, or cleaned up. Normalization is recorded separately so the original is never lost.',
  },
  {
    id: 'normalized_question',
    title: 'Normalized question',
    type: 'string',
    description: 'A deterministic normalization used only for duplicate detection - produced by the Information Gap Finder\'s own normalizeQuestion(), never a second implementation.',
  },
  {
    id: 'evidence_strength',
    title: 'Evidence strength',
    type: `enum: ${EVIDENCE_STRENGTHS.join(' | ')}`,
    description: 'Whether this question was directly observed at a verifiable source, inferred from real referenced evidence, or produced with no verifiable provenance at all. Never asserted by the model that reported the question - always derived from whether its source could be verified.',
  },
  {
    id: 'observations',
    title: 'Observations',
    type: 'array',
    description: 'Every place this question was actually observed, each retaining its own evidence_kind, source_type, source_reference, source_url, collected_at and original_observation. Merging duplicates unions this list rather than discarding provenance.',
  },
  {
    id: 'observation_count',
    title: 'Observation count',
    type: 'number',
    description: 'How many distinct observations support this question - corroboration strength, never a demand or volume figure.',
  },
  {
    id: 'source_types',
    title: 'Source types',
    type: 'array',
    description: 'The distinct acquisition paths across this record\'s observations.',
  },
  {
    id: 'demand_measured',
    title: 'Demand measured',
    type: 'boolean',
    description: 'Always false unless a legitimate source actually carried a real demand metric. No search volume, monthly searches, traffic, CTR, or ranking figure is ever estimated or invented - this field states that explicitly rather than leaving it to inference.',
  },
  {
    id: 'limitations',
    title: 'Limitations',
    type: 'array',
    description: 'Honest caveats about this record (e.g. provenance could not be verified, demand was not measured) - always populated, never omitted.',
  },
];

const ARRAY_FIELD_IDS = QUESTION_EVIDENCE_FIELDS.filter((field) => field.type === 'array').map(
  (field) => field.id
);

const OBSERVATION_FIELDS = [
  'evidence_kind',
  'source_type',
  'source_reference',
  'source_url',
  'collected_at',
  'original_observation',
];

// Builds one provenance entry. `original_observation` is a SHORT attestation of where
// the question was seen (e.g. "listed in the page's FAQ section") - deliberately not
// page content: this layer stores no scraped body text and copies no competitor wording.
function createObservation({
  evidenceKind,
  sourceType,
  sourceReference = '',
  sourceUrl = '',
  collectedAt = '',
  originalObservation = '',
} = {}) {
  return {
    evidence_kind: evidenceKind,
    source_type: sourceType,
    source_reference: sourceReference,
    source_url: sourceUrl,
    collected_at: collectedAt,
    original_observation: originalObservation,
  };
}

// Returns a blank record. Starts at the most cautious position possible -
// model_generated, no observations, demand explicitly not measured - so a record that
// is never populated can never read as observed evidence.
function createEmptyQuestionEvidenceRecord(question = '') {
  return {
    question,
    normalized_question: '',
    evidence_strength: 'model_generated',
    observations: [],
    observation_count: 0,
    source_types: [],
    demand_measured: false,
    limitations: [],
  };
}

function validateObservationShape(observation, index, errors) {
  if (typeof observation !== 'object' || observation === null || Array.isArray(observation)) {
    errors.push(`observations[${index}] must be a plain object`);
    return;
  }
  const actualIds = Object.keys(observation);
  for (const id of OBSERVATION_FIELDS) {
    if (!actualIds.includes(id)) errors.push(`observations[${index}] missing field: ${id}`);
  }
  for (const id of actualIds) {
    if (!OBSERVATION_FIELDS.includes(id)) errors.push(`observations[${index}] unexpected field: ${id}`);
  }
  if ('evidence_kind' in observation && !EVIDENCE_KINDS.includes(observation.evidence_kind)) {
    errors.push(`observations[${index}].evidence_kind must be one of: ${EVIDENCE_KINDS.join(', ')}`);
  }
  if ('source_type' in observation && !SOURCE_TYPES.includes(observation.source_type)) {
    errors.push(`observations[${index}].source_type must be one of: ${SOURCE_TYPES.join(', ')}`);
  }
}

// Checks shape only - never guesses or fills in anything missing, exactly like every
// other validate*Shape in agent/core/.
function validateQuestionEvidenceShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = QUESTION_EVIDENCE_FIELDS.map((field) => field.id);
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
  if ('demand_measured' in record && typeof record.demand_measured !== 'boolean') {
    errors.push('demand_measured must be a boolean');
  }
  if ('observation_count' in record && typeof record.observation_count !== 'number') {
    errors.push('observation_count must be a number');
  }
  if (Array.isArray(record.observations)) {
    record.observations.forEach((observation, index) => validateObservationShape(observation, index, errors));
    if (typeof record.observation_count === 'number' && record.observation_count !== record.observations.length) {
      errors.push('observation_count must equal the number of observations');
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  EVIDENCE_KINDS,
  SUPPORTED_EVIDENCE_KINDS,
  UNSUPPORTED_EVIDENCE_KINDS,
  SOURCE_TYPES,
  QUESTION_EVIDENCE_FIELDS,
  OBSERVATION_FIELDS,
  createObservation,
  createEmptyQuestionEvidenceRecord,
  validateQuestionEvidenceShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - question evidence model (schema only):\n');
  QUESTION_EVIDENCE_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log(`\nSupported evidence kinds:   ${SUPPORTED_EVIDENCE_KINDS.join(', ')}`);
  console.log(`Unsupported evidence kinds: ${UNSUPPORTED_EVIDENCE_KINDS.join(', ')}`);
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyQuestionEvidenceRecord('(no question set)'), null, 2));
}
