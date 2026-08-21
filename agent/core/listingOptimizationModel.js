'use strict';

// The shape of one product/listing optimization record. Schema and a couple of pure
// helpers only - no automated rewriting, publishing, or scoring logic.
//
// Every field here is a SUGGESTION, never a live edit: nothing in this module reads
// or writes real listing content under data/business/, and there is no apply/publish
// function to gate. Turning a suggestion into a real change to a store listing is a
// human-approved action via approvals/ (see approvals/README.md) - never automatic -
// which is how "do not overwrite real business content without approval" is satisfied
// structurally.
//
// Deliberately absent: any field that claims or predicts an SEO performance
// improvement (e.g. an expected ranking change or conversion lift). Only qualitative,
// evidence-checkable opportunities/considerations are captured - nothing here asserts
// a performance improvement without evidence, because there is no such field to fill.

const LISTING_OPTIMIZATION_FIELDS = [
  {
    id: 'product_reference',
    title: 'Product reference',
    type: 'string',
    description: 'Which product/listing this optimization is about (an agent/core/productModel.js product_identity value) - needed so a record is identifiable, the same role opportunity_reference plays in agent/core/opportunityAnalysisModel.js.',
  },
  {
    id: 'product_title',
    title: 'Product title',
    type: 'string',
    description: 'A suggested title for the listing - a proposal, never applied to the real listing without approval (see approvals/).',
  },
  {
    id: 'description',
    title: 'Description',
    type: 'string',
    description: 'A suggested description for the listing - a proposal, never applied to the real listing without approval (see approvals/).',
  },
  {
    id: 'keywords',
    title: 'Keywords',
    type: 'array',
    description: 'Keywords relevant to this listing - references to agent/core/seoResearchModel.js keyword records, not full reports.',
  },
  {
    id: 'search_intent',
    title: 'Search intent',
    type: 'string',
    description: 'The search intent this listing should serve, echoing agent/core/seoResearchModel.js search_intent.',
  },
  {
    id: 'structure',
    title: 'Structure',
    type: 'string',
    description: 'A recommended content structure/layout for the listing (e.g. heading order, sections) - qualitative, not a performance claim.',
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
    description: 'Qualitative opportunities for improving this listing internally (e.g. missing sections, weak headings) - not performance predictions.',
  },
  {
    id: 'conversion_considerations',
    title: 'Conversion considerations',
    type: 'array',
    description: 'Qualitative considerations relevant to conversion (e.g. trust signals, clarity) - not performance predictions.',
  },
];

const ARRAY_FIELD_IDS = LISTING_OPTIMIZATION_FIELDS.filter((field) => field.type === 'array').map(
  (field) => field.id
);
const OBJECT_FIELD_IDS = LISTING_OPTIMIZATION_FIELDS.filter((field) => field.type === 'object').map(
  (field) => field.id
);

// Returns a blank listing optimization record conforming to LISTING_OPTIMIZATION_FIELDS.
// No real listing content - callers fill it in, and applying it to a real listing
// still requires a separate, human-approved action (see approvals/).
function createEmptyListingOptimizationRecord(product_reference = '') {
  return {
    product_reference,
    product_title: '',
    description: '',
    keywords: [],
    search_intent: '',
    structure: '',
    metadata: { meta_title: '', meta_description: '', url_slug: '', alt_text: '' },
    internal_optimization_opportunities: [],
    conversion_considerations: [],
  };
}

// Checks that a listing optimization record has exactly the expected keys, with the
// expected basic shapes. Does not guess or fill in anything missing - only reports.
function validateListingOptimizationShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = LISTING_OPTIMIZATION_FIELDS.map((field) => field.id);
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

  return { valid: errors.length === 0, errors };
}

module.exports = {
  LISTING_OPTIMIZATION_FIELDS,
  createEmptyListingOptimizationRecord,
  validateListingOptimizationShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - listing optimization model (schema only):\n');
  LISTING_OPTIMIZATION_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyListingOptimizationRecord('(no product set)'), null, 2));
  console.log('\nEvery field above is a suggestion. Applying it to a real store listing requires');
  console.log('a separate, human-approved action (see approvals/) - never automatic.');
}
