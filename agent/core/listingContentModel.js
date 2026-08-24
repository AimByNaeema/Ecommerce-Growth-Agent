'use strict';

// The shape of one listing-content record - the structured output of the Listing
// Agent's core content capability: a product's title, description, benefits,
// features, selling points, FAQs, attributes, variants, and a call-to-action, all as
// they should appear in a listing. Schema and a couple of pure helpers only - no
// automated rewriting, publishing, or scoring logic, same convention as every other
// *Model.js file.
//
// cta (call-to-action) is always relayed caller-supplied text - either an explicit
// cta or a brand tagline passed straight through (see agent/core/listingAgent.js's
// resolveListingSources()) - never independently composed, matching every other field
// in this schema.
//
// This is deliberately a SEPARATE file from agent/core/listingOptimizationModel.js,
// not a widening of it. That file's product_title/description fields exist
// specifically for SEO's product_seo capability (keyword-driven suggestions - see
// agent/core/seoAgent.js); this file's fields exist for the Listing specialist's own
// concern (copywriting/content authoring, not search-visibility optimization). Both
// specialists may propose a title/description for the same real-world listing,
// referenced by the same product_reference convention - that is not duplication, it is
// two specialists assessing the same artifact from different angles, the same pattern
// agent/core/productAgent.js already uses for its demand/competition/market_fit/
// product_risk dimensions.
//
// "Do not invent product specifications": every field here is either a copy/structure
// suggestion (product_title, description) built only from what the caller explicitly
// supplies, or a direct structural echo of caller-supplied facts (features, attributes,
// variants). There is no AI/API call anywhere in this module (see agent/core/
// listingAgent.js's own header) and no code path that could synthesize a feature,
// attribute, or variant that wasn't supplied - the same deterministic, evidence-only
// guarantee as agent/core/seoResearchModel.js's keyword records never fabricating
// search volume.
//
// Every field here is a SUGGESTION, never a live edit: nothing in this module reads or
// writes real listing content, and there is no apply/publish function to gate. Turning
// a suggestion into a real change to a store listing is a human-approved action via
// approvals/ (see approvals/README.md) - never automatic.
//
// faqs, attributes, and variants follow the same light-validation convention every
// other small-object array field in this project already uses (e.g.
// listingOptimizationModel.js's headings/internal_links): the field itself must be an
// array, but individual entry shapes are not deeply validated - callers are trusted to
// supply the documented shape.

const LISTING_CONTENT_FIELDS = [
  {
    id: 'product_reference',
    title: 'Product reference',
    type: 'string',
    description: 'Which product/listing this content is about (an agent/core/productModel.js product_identity value) - needed so a record is identifiable, the same role product_reference plays in agent/core/listingOptimizationModel.js.',
  },
  {
    id: 'product_title',
    title: 'Product title',
    type: 'string',
    description: 'A suggested listing title - a proposal, never applied to the real listing without approval (see approvals/).',
  },
  {
    id: 'description',
    title: 'Description',
    type: 'string',
    description: 'A suggested listing description - a proposal, never applied to the real listing without approval (see approvals/). Never invents a factual product claim - only restates/reorganizes what the caller supplies.',
  },
  {
    id: 'benefits',
    title: 'Benefits',
    type: 'array',
    description: 'Customer-facing benefit statements (what the product does for the buyer) - built only from caller-supplied evidence, never invented.',
  },
  {
    id: 'features',
    title: 'Features',
    type: 'array',
    description: 'Concrete, factual product features (e.g. "waterproof", "10oz capacity") - caller-supplied facts only; this module never generates or infers one.',
  },
  {
    id: 'selling_points',
    title: 'Selling points',
    type: 'array',
    description: 'Key differentiators/unique selling propositions - grounded in caller-supplied evidence, never invented.',
  },
  {
    id: 'faqs',
    title: 'FAQs',
    type: 'array',
    description: 'Structured question/answer pairs for the listing (e.g. {question, answer} entries) - caller-supplied only; no answer is ever fabricated for an unverified claim.',
  },
  {
    id: 'attributes',
    title: 'Attributes',
    type: 'array',
    description: 'Structured factual attributes (e.g. {name, value} entries, such as {name: "material", value: "ripstop nylon"}) - caller-supplied facts only, never invented.',
  },
  {
    id: 'variants',
    title: 'Variants',
    type: 'array',
    description: 'Caller-supplied variant info structured for listing presentation (e.g. {variant_reference, title, differentiators} entries) - reflects supplied variant facts only; no variant is ever invented.',
  },
  {
    id: 'cta',
    title: 'CTA',
    type: 'string',
    description: 'A call-to-action for the listing - only ever caller-supplied text (an explicit cta, or a brand tagline relayed as-is), never independently written.',
  },
];

const ARRAY_FIELD_IDS = LISTING_CONTENT_FIELDS.filter((field) => field.type === 'array').map(
  (field) => field.id
);

// Returns a blank listing-content record conforming to LISTING_CONTENT_FIELDS. No real
// listing content - callers fill it in, and applying it to a real listing still
// requires a separate, human-approved action (see approvals/).
function createEmptyListingContentRecord(product_reference = '') {
  return {
    product_reference,
    product_title: '',
    description: '',
    benefits: [],
    features: [],
    selling_points: [],
    faqs: [],
    attributes: [],
    variants: [],
    cta: '',
  };
}

// Checks that a listing-content record has exactly the expected keys, with the
// expected basic shapes. Does not guess or fill in anything missing - only reports.
function validateListingContentShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = LISTING_CONTENT_FIELDS.map((field) => field.id);
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

  return { valid: errors.length === 0, errors };
}

module.exports = {
  LISTING_CONTENT_FIELDS,
  createEmptyListingContentRecord,
  validateListingContentShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - listing content model (schema only):\n');
  LISTING_CONTENT_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyListingContentRecord('(no product set)'), null, 2));
  console.log('\nEvery field above is a suggestion built only from caller-supplied input.');
  console.log('Applying it to a real store listing requires a separate, human-approved');
  console.log('action (see approvals/) - never automatic.');
}
