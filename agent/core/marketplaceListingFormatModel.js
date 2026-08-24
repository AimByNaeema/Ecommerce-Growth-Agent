'use strict';

// The shape of one marketplace-formatted rendering of a listing-content record (see
// agent/core/listingContentModel.js) - the structured output of the Listing Agent's
// marketplace-format capability. Schema and a couple of pure helpers only - no
// automated rewriting, publishing, or scoring logic, same convention as every other
// *Model.js file.
//
// `marketplace` is a free-form string, not a hardcoded enum. Per CLAUDE.md rule 14
// ("configurable by design"), which marketplaces this project targets is a business
// decision, not a code decision - adding a new marketplace (e.g. Etsy, eBay, Amazon)
// must never require a code change here.
//
// Formatting is pure, deterministic truncation/mapping against caller-supplied
// constraints (e.g. {maxTitleLength, maxDescriptionLength}) - it never invents new
// content. With no constraints supplied, the source content is echoed through as-is,
// noted honestly in format_constraints_applied/limitations rather than silently
// reformatted. See agent/core/listingAgent.js's formatForMarketplace().
//
// Every field here is a SUGGESTION, never a live edit: nothing in this module reads or
// writes a real marketplace listing, and there is no apply/publish function to gate.
// Turning this into a real marketplace listing is a human-approved action via
// approvals/ (see approvals/README.md) - never automatic.

const MARKETPLACE_LISTING_FORMAT_FIELDS = [
  {
    id: 'marketplace',
    title: 'Marketplace',
    type: 'string',
    description: 'Which marketplace channel this formatted listing targets (e.g. "etsy", "amazon", "shopify") - free-form, not a hardcoded enum, so new marketplaces need no code change.',
  },
  {
    id: 'product_reference',
    title: 'Product reference',
    type: 'string',
    description: 'Which product/listing this formatted rendering is about - the same agent/core/productModel.js product_identity value used by agent/core/listingContentModel.js.',
  },
  {
    id: 'formatted_title',
    title: 'Formatted title',
    type: 'string',
    description: 'The source listing title, deterministically truncated/mapped to this marketplace\'s caller-supplied constraints - never a newly generated title.',
  },
  {
    id: 'formatted_description',
    title: 'Formatted description',
    type: 'string',
    description: 'The source listing description, deterministically truncated/mapped to this marketplace\'s caller-supplied constraints - never newly generated content.',
  },
  {
    id: 'formatted_attributes',
    title: 'Formatted attributes',
    type: 'array',
    description: 'The source listing\'s attributes (agent/core/listingContentModel.js attributes), carried through unchanged - {name, value} entries, never invented.',
  },
  {
    id: 'format_constraints_applied',
    title: 'Format constraints applied',
    type: 'array',
    description: 'A human-readable record of which constraints were actually applied (e.g. "title truncated to 80 characters") - so a truncation is always visible, never silent.',
  },
];

const ARRAY_FIELD_IDS = MARKETPLACE_LISTING_FORMAT_FIELDS.filter((field) => field.type === 'array').map(
  (field) => field.id
);

// Returns a blank marketplace-listing-format record conforming to
// MARKETPLACE_LISTING_FORMAT_FIELDS. No real formatted content - callers fill it in,
// and applying it to a real marketplace listing still requires a separate,
// human-approved action (see approvals/).
function createEmptyMarketplaceListingFormatRecord(marketplace = '', product_reference = '') {
  return {
    marketplace,
    product_reference,
    formatted_title: '',
    formatted_description: '',
    formatted_attributes: [],
    format_constraints_applied: [],
  };
}

// Checks that a marketplace-listing-format record has exactly the expected keys, with
// the expected basic shapes. Does not guess or fill in anything missing - only reports.
function validateMarketplaceListingFormatShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = MARKETPLACE_LISTING_FORMAT_FIELDS.map((field) => field.id);
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
  MARKETPLACE_LISTING_FORMAT_FIELDS,
  createEmptyMarketplaceListingFormatRecord,
  validateMarketplaceListingFormatShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - marketplace listing format model (schema only):\n');
  MARKETPLACE_LISTING_FORMAT_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty record:');
  console.log(JSON.stringify(createEmptyMarketplaceListingFormatRecord('etsy', '(no product set)'), null, 2));
  console.log('\nEvery field above is a deterministic reformatting of caller-supplied content.');
  console.log('Applying it to a real marketplace listing requires a separate, human-approved');
  console.log('action (see approvals/) - never automatic.');
}
