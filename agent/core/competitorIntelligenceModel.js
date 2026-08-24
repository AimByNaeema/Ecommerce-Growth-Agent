'use strict';

// The shape one structured competitor intelligence result conforms to - the output of
// agent/core/competitorIntelligenceAgent.js. Schema and a couple of pure helpers only,
// following the exact convention of every existing *Model.js file (createEmpty* +
// validate*Shape + CLI printer) - no analysis logic lives here.
//
// Shallow validation only (exact top-level key set + array-type checks), matching
// agent/core/researchAgentResultModel.js's own convention for its specialized_records
// field: the underlying agent/core/competitorResearchModel.js record and the generic
// agent/core/researchRecordModel.js records this result is built from are already
// validated by their own models during retrieval - this envelope does not re-validate
// them.
//
// COMPETITOR_INTELLIGENCE_AREAS is the fixed set of 8 areas this result always reports
// on: products, positioning, pricing, offers, listings, seo_signals, social_presence,
// advertising_signals. Every result carries all 8, whether or not real data exists for
// each - see data_availability, which is never silently incomplete.

const COMPETITOR_INTELLIGENCE_AREAS = [
  'products',
  'positioning',
  'pricing',
  'offers',
  'listings',
  'seo_signals',
  'social_presence',
  'advertising_signals',
];

const COMPETITOR_INTELLIGENCE_FIELDS = [
  {
    id: 'competitor',
    title: 'Competitor',
    type: 'string',
    description: "The competitor's name or identifier - no real competitor invented here.",
  },
  {
    id: 'market',
    title: 'Market',
    type: 'string',
    description: 'Which market this result applies to.',
  },
  {
    id: 'research_date',
    title: 'Research date',
    type: 'string',
    description: 'When this result was produced (ISO date).',
  },
  {
    id: 'data_availability',
    title: 'Data availability',
    type: 'object',
    description: "One status per area in COMPETITOR_INTELLIGENCE_AREAS - 'empty' (nothing supplied), 'partial' (supplied but not evidenced), or 'success' (supplied and evidenced). A structural audit, never an invented judgment.",
  },
  {
    id: 'observed_facts',
    title: 'Observed facts',
    type: 'array',
    description: 'One entry per area: { area, statement_type: "observed_fact", findings, evidence } - raw caller-supplied content only, never a judgment.',
  },
  {
    id: 'analysis',
    title: 'Analysis',
    type: 'array',
    description: 'One entry per area: { area, statement_type: "interpretation", status, text } - the data-availability audit, derived only from whether evidence exists, never a fabricated competitive insight.',
  },
  {
    id: 'recommendations',
    title: 'Recommendations',
    type: 'array',
    description: 'Caller-supplied recommendation strings only - never invented, matching every other model in this codebase.',
  },
  {
    id: 'limitations',
    title: 'Limitations',
    type: 'array',
    description: 'Honest gaps/caveats.',
  },
  {
    id: 'source',
    title: 'Source',
    type: 'array',
    description: 'The flattened union of every area\'s evidence, for quick top-level access.',
  },
  {
    id: 'specialized_records',
    title: 'Specialized records',
    type: 'object',
    description: '{ competitor_record, area_records: { [area]: [...] } } - the full underlying validated records this result was composed from, so every claim is traceable to its origin.',
  },
];

const ARRAY_FIELD_IDS = COMPETITOR_INTELLIGENCE_FIELDS.filter((field) => field.type === 'array').map(
  (field) => field.id
);
const OBJECT_FIELD_IDS = COMPETITOR_INTELLIGENCE_FIELDS.filter((field) => field.type === 'object').map(
  (field) => field.id
);

function emptyDataAvailability() {
  const availability = {};
  for (const area of COMPETITOR_INTELLIGENCE_AREAS) {
    availability[area] = 'empty';
  }
  return availability;
}

// Returns a blank competitor intelligence record. No real competitor data - callers
// (agent/core/competitorIntelligenceAgent.js) fill it in.
function createEmptyCompetitorIntelligence(competitor = '') {
  return {
    competitor,
    market: '',
    research_date: '',
    data_availability: emptyDataAvailability(),
    observed_facts: [],
    analysis: [],
    recommendations: [],
    limitations: [],
    source: [],
    specialized_records: { competitor_record: null, area_records: {} },
  };
}

// Checks that a competitor intelligence record has exactly the expected keys, with
// the expected basic shapes. Does not guess or fill in anything missing - only
// reports.
function validateCompetitorIntelligenceShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = COMPETITOR_INTELLIGENCE_FIELDS.map((field) => field.id);
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

  for (const id of OBJECT_FIELD_IDS) {
    if (id in record && (typeof record[id] !== 'object' || record[id] === null || Array.isArray(record[id]))) {
      errors.push(`${id} must be an object`);
    }
  }

  if ('data_availability' in record && typeof record.data_availability === 'object' && record.data_availability !== null) {
    const availability = record.data_availability;
    for (const area of COMPETITOR_INTELLIGENCE_AREAS) {
      if (!(area in availability)) {
        errors.push(`data_availability is missing area: ${area}`);
      }
    }
    for (const area of Object.keys(availability)) {
      if (!COMPETITOR_INTELLIGENCE_AREAS.includes(area)) {
        errors.push(`data_availability has unexpected area: ${area}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  COMPETITOR_INTELLIGENCE_AREAS,
  COMPETITOR_INTELLIGENCE_FIELDS,
  createEmptyCompetitorIntelligence,
  validateCompetitorIntelligenceShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - competitor intelligence model (schema only):\n');
  COMPETITOR_INTELLIGENCE_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyCompetitorIntelligence('(no competitor set)'), null, 2));
  console.log('\nNo competitor data is invented here - real values come only from cited source evidence.');
}
