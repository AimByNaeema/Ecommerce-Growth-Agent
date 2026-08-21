'use strict';

// The shape one product record conforms to. This is a schema and a couple of pure
// helpers only - no file I/O, no database, no product-hunting/scraping/sourcing logic.
// Real instances of this shape are meant to live under data/products/ (see
// data/products/README.md) once real catalog data exists - none is invented here.
//
// Fields hold compact facts and references, never full documents:
// - source references where product info came from (e.g. a store export, a supplier
//   listing), not full documents.
// - pricing is a small nested group (currency/cost/price), same convention as
//   configuration/business.example.yaml's brand group - no values invented.

const AVAILABILITY_STATUSES = ['unknown', 'available', 'unavailable', 'discontinued', 'planned'];
const PRODUCT_RESEARCH_STATUSES = ['not_researched', 'researching', 'researched', 'needs_update'];

const PRODUCT_FIELDS = [
  {
    id: 'product_identity',
    title: 'Product identity',
    type: 'string',
    description: 'A name or identifier for the product - no ID scheme invented here.',
  },
  {
    id: 'category',
    title: 'Category',
    type: 'string',
    description: 'The product category it belongs to.',
  },
  {
    id: 'product_model',
    title: 'Product model',
    type: 'string',
    description: 'How this specific product is sourced/fulfilled (e.g. in-house, dropshipping, print-on-demand, wholesale) - the product-level counterpart to business.yaml\'s business-wide product_model.',
  },
  {
    id: 'description',
    title: 'Description',
    type: 'string',
    description: 'A description of the product.',
  },
  {
    id: 'positioning',
    title: 'Positioning',
    type: 'string',
    description: 'How the product is positioned relative to alternatives.',
  },
  {
    id: 'target_customer',
    title: 'Target customer',
    type: 'string',
    description: 'Who the product is aimed at.',
  },
  {
    id: 'market',
    title: 'Market',
    type: 'array',
    description: 'Markets this product targets - echoes business.yaml\'s target_markets.',
  },
  {
    id: 'pricing',
    title: 'Pricing information',
    type: 'object',
    description: 'A small nested group: currency, cost, price. No values invented here.',
  },
  {
    id: 'availability',
    title: 'Availability',
    type: `enum: ${AVAILABILITY_STATUSES.join(' | ')}`,
    description: 'Current availability status of the product.',
  },
  {
    id: 'source',
    title: 'Source',
    type: 'array',
    description: 'References to where this product info came from (e.g. a store export, a supplier listing) - not full documents.',
  },
  {
    id: 'research_status',
    title: 'Research status',
    type: `enum: ${PRODUCT_RESEARCH_STATUSES.join(' | ')}`,
    description: 'Whether this product has been researched yet - distinct from a task\'s verification_status and a research record\'s verification_status.',
  },
];

const ARRAY_FIELD_IDS = PRODUCT_FIELDS.filter((field) => field.type === 'array').map((field) => field.id);
const OBJECT_FIELD_IDS = PRODUCT_FIELDS.filter((field) => field.type === 'object').map((field) => field.id);

// Returns a blank product record conforming to PRODUCT_FIELDS. No product data -
// callers fill it in.
function createEmptyProductRecord(product_identity = '') {
  return {
    product_identity,
    category: '',
    product_model: '',
    description: '',
    positioning: '',
    target_customer: '',
    market: [],
    pricing: { currency: '', cost: '', price: '' },
    availability: 'unknown',
    source: [],
    research_status: 'not_researched',
  };
}

// Checks that a product record has exactly the expected keys, with the expected basic
// shapes. Does not guess or fill in anything missing - only reports.
function validateProductRecordShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = PRODUCT_FIELDS.map((field) => field.id);
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

  if ('availability' in record && !AVAILABILITY_STATUSES.includes(record.availability)) {
    errors.push(`availability must be one of: ${AVAILABILITY_STATUSES.join(', ')}`);
  }
  if ('research_status' in record && !PRODUCT_RESEARCH_STATUSES.includes(record.research_status)) {
    errors.push(`research_status must be one of: ${PRODUCT_RESEARCH_STATUSES.join(', ')}`);
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  PRODUCT_FIELDS,
  AVAILABILITY_STATUSES,
  PRODUCT_RESEARCH_STATUSES,
  createEmptyProductRecord,
  validateProductRecordShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - product record model (schema only):\n');
  PRODUCT_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty product record:');
  console.log(JSON.stringify(createEmptyProductRecord('(no product identity set)'), null, 2));
}
