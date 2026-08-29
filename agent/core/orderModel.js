'use strict';

// The shape one order record conforms to. This is a schema and a couple of pure
// helpers only - no file I/O, no database, no fetch/pull/sync logic, no arithmetic.
// Same convention as agent/core/productModel.js and agent/core/analyticsModel.js: a
// `*_FIELDS` array + `createEmpty*()` + `validate*Shape()`.
//
// WHY THIS FILE EXISTS: the multi-platform architecture review found that, unlike
// product/listing/analytics/research, order data had no first-class model - it was
// consumed ad hoc (plain field access) inside agent/core/analyticsMetricsCalculator.js,
// shaped only by convention around integrations/adapters/shopifyClient.js's getOrders()
// output. This file closes that gap with a normalized, platform-independent order
// schema any adapter's getOrders() can be mapped into (see
// integrations/adapters/platformAdapterContract.js's getOrders capability entry).
//
// PLATFORM-INDEPENDENT BY DESIGN: field names are generic e-commerce vocabulary
// (order_reference, placed_at, financial_status, fulfillment_status, pricing,
// line_items, customer_reference) - no Shopify-specific concept (GraphQL node shapes,
// `admin_graphql_api_id`, `displayFinancialStatus`/`displayFulfillmentStatus` naming)
// appears here. `financial_status`/`fulfillment_status` use their own small, generic
// enums instead of Shopify's raw status strings - the same order concept exists across
// every future platform this project may adapt to (Amazon, Etsy, eBay, WooCommerce).
//
// `customer_reference` is a reference only (an id/handle), never PII - same
// privacy-conscious convention integrations/adapters/shopifyClient.js's getCustomers()
// already established (see that file's own header: "customers where permitted").
//
// `verification_status` reuses agent/core/researchRecordModel.js's existing
// RESEARCH_VERIFICATION_STATUSES enum rather than redefining it - same cross-schema
// reuse precedent agent/core/analyticsModel.js already established: order data is
// objective/measured, not judged, so verification_status (not confidence) is the right
// fit.
//
// This file does not change how orders currently reach the system
// (integrations/adapters/shopifyClient.js's getOrders() is untouched) and does not
// wire this schema into agent/core/analyticsMetricsCalculator.js or any of the 8
// agents - that reuse is later, explicitly-scoped work.

const { RESEARCH_VERIFICATION_STATUSES } = require('./researchRecordModel');

const ORDER_FINANCIAL_STATUSES = [
  'unknown',
  'pending',
  'authorized',
  'partially_paid',
  'paid',
  'partially_refunded',
  'refunded',
  'voided',
];

const ORDER_FULFILLMENT_STATUSES = [
  'unknown',
  'unfulfilled',
  'partial',
  'fulfilled',
  'restocked',
];

const ORDER_FIELDS = [
  {
    id: 'order_reference',
    title: 'Order reference',
    type: 'string',
    description: 'A platform-native order identifier or number - no ID scheme invented here.',
  },
  {
    id: 'placed_at',
    title: 'Placed at',
    type: 'string',
    description: 'When the order was placed - no timestamp format invented; passed through as the source provides it.',
  },
  {
    id: 'financial_status',
    title: 'Financial status',
    type: `enum: ${ORDER_FINANCIAL_STATUSES.join(' | ')}`,
    description: 'Payment status of the order, in generic terms every platform maps into.',
  },
  {
    id: 'fulfillment_status',
    title: 'Fulfillment status',
    type: `enum: ${ORDER_FULFILLMENT_STATUSES.join(' | ')}`,
    description: 'Shipping/fulfillment status of the order, in generic terms every platform maps into.',
  },
  {
    id: 'pricing',
    title: 'Pricing information',
    type: 'object',
    description: 'A small nested group: currency, total. No values invented here.',
  },
  {
    id: 'line_items',
    title: 'Line items',
    type: 'array',
    description: 'The order\'s line items (e.g. title, quantity, sku) - not full product records.',
  },
  {
    id: 'customer_reference',
    title: 'Customer reference',
    type: 'string',
    description: 'A reference (id/identifier) to the customer who placed the order - never a name, email, phone, or address.',
  },
  {
    id: 'source',
    title: 'Source',
    type: 'array',
    description: 'References to where this order data came from (e.g. a platform API pull) - not full documents.',
  },
  {
    id: 'verification_status',
    title: 'Verification status',
    type: `enum: ${RESEARCH_VERIFICATION_STATUSES.join(' | ')}`,
    description: 'Reuses agent/core/researchRecordModel.js\'s enum - order data is objective/measured, not judged.',
  },
];

const ARRAY_FIELD_IDS = ORDER_FIELDS.filter((field) => field.type === 'array').map((field) => field.id);
const OBJECT_FIELD_IDS = ORDER_FIELDS.filter((field) => field.type === 'object').map((field) => field.id);

// Returns a blank order record conforming to ORDER_FIELDS. No order data - callers
// fill it in.
function createEmptyOrderRecord(order_reference = '') {
  return {
    order_reference,
    placed_at: '',
    financial_status: 'unknown',
    fulfillment_status: 'unknown',
    pricing: { currency: '', total: '' },
    line_items: [],
    customer_reference: '',
    source: [],
    verification_status: 'unverified',
  };
}

// Checks that an order record has exactly the expected keys, with the expected basic
// shapes. Does not guess or fill in anything missing - only reports.
function validateOrderRecordShape(record) {
  const errors = [];

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a plain object'] };
  }

  const expectedIds = ORDER_FIELDS.map((field) => field.id);
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

  if ('financial_status' in record && !ORDER_FINANCIAL_STATUSES.includes(record.financial_status)) {
    errors.push(`financial_status must be one of: ${ORDER_FINANCIAL_STATUSES.join(', ')}`);
  }
  if ('fulfillment_status' in record && !ORDER_FULFILLMENT_STATUSES.includes(record.fulfillment_status)) {
    errors.push(`fulfillment_status must be one of: ${ORDER_FULFILLMENT_STATUSES.join(', ')}`);
  }
  if ('verification_status' in record && !RESEARCH_VERIFICATION_STATUSES.includes(record.verification_status)) {
    errors.push(`verification_status must be one of: ${RESEARCH_VERIFICATION_STATUSES.join(', ')}`);
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  ORDER_FIELDS,
  ORDER_FINANCIAL_STATUSES,
  ORDER_FULFILLMENT_STATUSES,
  createEmptyOrderRecord,
  validateOrderRecordShape,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - order record model (schema only):\n');
  ORDER_FIELDS.forEach((field, index) => {
    console.log(`${index + 1}. [${field.id}] ${field.title} (${field.type})`);
    console.log(`   ${field.description}`);
  });
  console.log('\nExample empty order record:');
  console.log(JSON.stringify(createEmptyOrderRecord('(no order reference set)'), null, 2));
}
