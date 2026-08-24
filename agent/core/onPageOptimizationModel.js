'use strict';

// The shape of one collection/content-page on-page-optimization record. Schema and a
// couple of pure helpers only - no automated rewriting, publishing, or scoring logic,
// same convention as agent/core/listingOptimizationModel.js.
//
// listingOptimizationModel.js already covers product listings (product_reference,
// product_title). Nothing in this project covers a collection or content page - this
// file is that missing, generalized shape, kept as a separate file rather than
// renaming/generalizing the already-shipped listingOptimizationModel.js. `subject_type`
// distinguishes which kind of page a record is about; the remaining fields deliberately
// mirror listingOptimizationModel.js's field-for-field so the two schemas stay easy to
// reason about together.
//
// Every field here is a SUGGESTION, never a live edit: nothing in this module reads or
// writes real collection/content data, and there is no apply/publish function to gate.
// Turning a suggestion into a real change still requires a separate, human-approved
// action (see approvals/) - never automatic.
//
// Deliberately absent: any field that claims or predicts an SEO performance
// improvement. Only qualitative, evidence-checkable opportunities/considerations are
// captured.

const SUBJECT_TYPES = ['collection', 'content'];

const ON_PAGE_OPTIMIZATION_FIELDS = [
  {
    id: 'subject_type',
    title: 'Subject type',
    type: `enum: ${SUBJECT_TYPES.join(' | ')}`,
    description: 'Which kind of page this optimization record is about.',
  },
  {
    id: 'subject_reference',
    title: 'Subject reference',
    type: 'string',
    description: 'Which collection/content page this optimization is about - an identifiable reference (e.g. collection handle, content page URL/slug), the same role product_reference plays in agent/core/listingOptimizationModel.js.',
  },
  {
    id: 'subject_title',
    title: 'Subject title',
    type: 'string',
    description: 'A suggested title for the page - a proposal, never applied without approval (see approvals/).',
  },
  {
    id: 'description',
    title: 'Description',
    type: 'string',
    description: 'A suggested description/body copy for the page - a proposal, never applied without approval (see approvals/).',
  },
  {
    id: 'keywords',
    title: 'Keywords',
    type: 'array',
    description: 'Keywords relevant to this page - references to agent/core/seoResearchModel.js keyword records, not full reports.',
  },
  {
    id: 'search_intent',
    title: 'Search intent',
    type: 'string',
    description: 'The search intent this page should serve, echoing agent/core/seoResearchModel.js search_intent.',
  },
  {
    id: 'structure',
    title: 'Structure',
    type: 'string',
    description: 'A recommended content structure/layout for the page (e.g. heading order, sections) - qualitative, not a performance claim.',
  },
  {
    id: 'metadata',
    title: 'Metadata',
    type: 'object',
    description: 'A small nested group: meta_title, meta_description, url_slug, alt_text. No values invented here.',
  },
  {
    id: 'internal_optimization_opportunities',
    title: 'Internal optimization opportunities',
    type: 'array',
    description: 'Qualitative opportunities for improving this page internally (e.g. missing sections, weak headings) - not performance predictions.',
  },
  {
    id: 'conversion_considerations',
    title: 'Conversion considerations',
    type: 'array',
    description: 'Qualitative considerations relevant to conversion (e.g. trust signals, clarity) - not performance predictions.',
  },
];

const ARRAY_FIELD_IDS = ON_PAGE_OPTIMIZATION_FIELDS.filter((field) => field.type === 'array').map(
  (field) => field.id
);
const OBJECT_FIELD_IDS = ON_PAGE_OPTIMIZATION_FIELDS.filter((field) => field.type === 'object').map(
  (field) => field.id
);

// Returns a blank on-page optimization record conforming to ON_PAGE_OPTIMIZATION_FIELDS.
// No real page content - callers fill it in, and applying it to a real page still
// requires a separate, human-approved action (see approvals/).
function createEmptyOnPageOptimizationRecord(subject_type = '', subject_reference = '') {
  return {
    subject_type,
    subject_reference,
    subject_title: '',
    description: '',
    keywords: [],
    search_intent: '',
    structure: '',
    metadata: { meta_title: '', meta_description: '', url_slug: '', alt_text: '' },
    internal_optimization_opportunities: [],
    conversion_considerations: [],
  };
}

// Checks that an on-page optimization record has exactly the expected keys, with the
// expected basic shapes. Does not guess or fill in anything missing - only reports.
function validateOnPageOptimizationShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = ON_PAGE_OPTIMIZATION_FIELDS.map((field) => field.id);
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

  if ('subject_type' in record && !SUBJECT_TYPES.includes(record.subject_type)) {
    errors.push(`subject_type must be one of: ${SUBJECT_TYPES.join(', ')}`);
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  SUBJECT_TYPES,
  ON_PAGE_OPTIMIZATION_FIELDS,
  createEmptyOnPageOptimizationRecord,
  validateOnPageOptimizationShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - on-page optimization model (schema only):\n');
  ON_PAGE_OPTIMIZATION_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyOnPageOptimizationRecord('collection', '(no subject set)'), null, 2));
  console.log('\nEvery field above is a suggestion. Applying it to a real page requires');
  console.log('a separate, human-approved action (see approvals/) - never automatic.');
}
