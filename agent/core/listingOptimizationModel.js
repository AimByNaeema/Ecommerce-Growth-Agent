'use strict';

// The shape of one product/listing optimization record - the structured output of
// "ecommerce product SEO optimization": recommendations for a product's title, meta
// description, headings, description, keyword usage, internal links, and supporting
// content. Schema and a couple of pure helpers only - no automated rewriting,
// publishing, or scoring logic.
//
// Every field here is a SUGGESTION, never a live edit: nothing in this module reads
// or writes real listing content under data/business/, and there is no apply/publish
// function to gate. Turning a suggestion into a real change to a store listing is a
// human-approved action via approvals/ (see approvals/README.md) - never automatic -
// which is how "do not overwrite real business content without approval" and "do not
// automatically publish changes" are both satisfied structurally, not just by
// convention.
//
// "Preserve factual product information": this module never generates or infers a
// factual product claim (price, material, dimensions, etc.) - every field is either a
// copy/structure suggestion (product_title, description, headings, structure) built
// only from what the caller explicitly supplies, or a reference (keywords,
// keyword_usage, internal_links) to something that already exists elsewhere. There is
// no code path that could overwrite a real product's factual data, since nothing here
// ever reads or writes real listing content in the first place.
//
// Deliberately absent: any field that claims or predicts an SEO performance
// improvement (e.g. an expected ranking change or conversion lift). Only qualitative,
// evidence-checkable opportunities/considerations are captured - nothing here asserts
// a performance improvement without evidence, because there is no such field to fill.
//
// headings, internal_links, and cost_components-style small object arrays follow the
// same light-validation convention agent/core/productAgentResultModel.js's
// profitability_inputs.cost_components already established in this project: the field
// itself must be an array, but individual entry shapes are not deeply validated -
// callers are trusted to supply the documented {level, text} / {anchor_text, target}
// shape, consistent with every other array field in this project never being deeply
// validated per-item either.

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
    description: 'A suggested description for the listing - a proposal, never applied to the real listing without approval (see approvals/). Never invents a factual product claim - only restates/reorganizes what the caller supplies.',
  },
  {
    id: 'keywords',
    title: 'Keywords',
    type: 'array',
    description: 'Keywords relevant to this listing - references to agent/core/seoResearchModel.js keyword records, not full reports.',
  },
  {
    id: 'keyword_usage',
    title: 'Keyword usage',
    type: 'array',
    description: 'Guidance on where to use each keyword (e.g. {keyword, placement} entries, placement being e.g. "title", "h1", "first paragraph") - never a ranking, volume, or usage-frequency claim.',
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
    description: 'A recommended content structure/layout for the listing (e.g. section order) - qualitative, not a performance claim.',
  },
  {
    id: 'headings',
    title: 'Headings',
    type: 'array',
    description: 'A suggested heading structure for the listing (e.g. {level, text} entries, H1 first) - a proposal, never applied without approval (see approvals/).',
  },
  {
    id: 'metadata',
    title: 'Metadata',
    type: 'object',
    description: 'A small nested group: meta_title, meta_description, url_slug, alt_text. No values invented here.',
  },
  {
    id: 'internal_links',
    title: 'Internal links',
    type: 'array',
    description: 'Suggested internal links to other pages (e.g. {anchor_text, target} entries, target being a product/collection/content reference) - references, not live links; never applied without approval.',
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
  {
    id: 'supporting_content',
    title: 'Supporting content',
    type: 'array',
    description: 'Suggested supporting content ideas for this listing (e.g. a buying guide, an FAQ section) - qualitative ideas, not full drafted content.',
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
    keyword_usage: [],
    search_intent: '',
    structure: '',
    headings: [],
    metadata: { meta_title: '', meta_description: '', url_slug: '', alt_text: '' },
    internal_links: [],
    internal_optimization_opportunities: [],
    conversion_considerations: [],
    supporting_content: [],
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
