'use strict';

// The Shopify collection membership workflow - one of three write orchestration
// wrappers built alongside integrations/shopifyBlogPublishing.js's existing chain, and
// shaped identically to it:
//
//   Compliance -> Human Approval -> Publish Authorization -> Shopify collectionAddProducts
//
// Adds ONE product to ONE already-existing collection. Never creates a collection,
// never removes a product from any collection, never touches any other field. See
// integrations/shopifyVendorCorrection.js's header for the shared design rationale
// (re-check immediately before the mutation, fail closed, one call site, independent
// re-read, no client-supplied approval state trusted).

const shopifyClient = require('./adapters/shopifyClient');
const { authorizePublishing } = require('../approvals/publishAuthorization');
const { appendAuditEvent } = require('../audit/auditTrail');

const PLATFORM = 'shopify';
const DESTINATION = 'collection_membership';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// Adds one already-authorized product to one already-existing collection, then
// independently re-reads both the collection's product count and the product's own
// collection list to confirm membership actually took (collectionAddProducts may not be
// guaranteed synchronous on every API version, so this retries the re-read a bounded
// number of times before reporting unconfirmed).
//
//   requests, requestId, contentReference, specialistId, businessId, auditTracker - as
//     in correctProductVendor().
//   collectionId - the target collection's gid://shopify/Collection/... id. Required.
//   productId    - the product's gid://shopify/Product/... id to add. Required.
//
// Returns { succeeded, status, reason, authorization, result }.
async function addProductToFreeDesignsCollection({
  requests,
  requestId,
  contentReference,
  collectionId,
  productId,
  specialistId = 'product',
  businessId = null,
  auditTracker = null,
} = {}) {
  if (!Array.isArray(requests)) {
    throw new Error(
      'addProductToFreeDesignsCollection requires the server-held `requests` array. It never accepts an approval record, an approval status, or an authorization result from a caller.'
    );
  }

  const authorization = authorizePublishing({ requests, requestId, contentReference, specialistId, auditTracker });

  if (!authorization.authorized) {
    appendAuditEvent(auditTracker, {
      type: 'execution',
      toolId: null,
      specialistId: specialistId === undefined ? null : specialistId,
      status: 'refused',
      summary: `Shopify collection membership update REFUSED for '${contentReference || '(no content reference)'}' - not authorized (${authorization.failed_check}). No Shopify call was made.`,
      detail: { failed_check: authorization.failed_check, platform: PLATFORM, destination: DESTINATION },
    });
    return { succeeded: false, status: 'refused', reason: authorization.reason, authorization, result: null };
  }

  const missing = [];
  if (!isNonEmptyString(collectionId)) missing.push('a collectionId');
  if (!isNonEmptyString(productId)) missing.push('a productId');
  if (missing.length > 0) {
    const reason = `Nothing was added: ${missing.join('; ')}. Nothing here is substituted or invented.`;
    appendAuditEvent(auditTracker, {
      type: 'error',
      status: 'error',
      summary: `Shopify collection membership update REFUSED for '${contentReference}' - ${reason} No Shopify call was made.`,
      detail: { platform: PLATFORM, destination: DESTINATION },
    });
    return { succeeded: false, status: 'refused', reason, authorization, result: null };
  }

  appendAuditEvent(auditTracker, {
    type: 'execution',
    specialistId: specialistId === undefined ? null : specialistId,
    status: 'attempted',
    summary: `Shopify collection membership update ATTEMPTED for '${contentReference}' under approval '${requestId}' (compliance ${authorization.compliance_status}): product '${productId}' -> collection '${collectionId}'.`,
    detail: { platform: PLATFORM, destination: DESTINATION, approval_id: requestId, decided_by: authorization.approval.decided_by, product_id: productId, collection_id: collectionId },
  });

  let result;
  try {
    result = await shopifyClient.addProductsToCollection({ collectionId, productIds: [productId], businessId });
  } catch (err) {
    appendAuditEvent(auditTracker, {
      type: 'error',
      specialistId: specialistId === undefined ? null : specialistId,
      status: 'failed',
      summary: `Shopify collection membership update FAILED for '${contentReference}': ${err.message}`,
      detail: { platform: PLATFORM, destination: DESTINATION, approval_id: requestId },
    });
    return { succeeded: false, status: 'failed', reason: err.message, authorization, result: null };
  }

  // Independent re-read, with a small bounded retry: collectionAddProducts is not
  // guaranteed synchronous on every API version, so an immediate re-read that doesn't
  // yet show membership is retried a few times before being reported unconfirmed -
  // never assumed successful from the mutation's own response alone.
  const maxAttempts = 3;
  let confirmed = false;
  let lastProduct = null;
  for (let attempt = 1; attempt <= maxAttempts && !confirmed; attempt += 1) {
    let products;
    try {
      products = await shopifyClient.getProducts({ limit: 250, businessId });
    } catch (err) {
      appendAuditEvent(auditTracker, {
        type: 'error',
        specialistId: specialistId === undefined ? null : specialistId,
        status: 'error',
        summary: `Shopify collection membership update for '${contentReference}' mutated successfully, but re-read attempt ${attempt} failed: ${err.message}`,
        detail: { platform: PLATFORM, destination: DESTINATION, approval_id: requestId },
      });
      continue;
    }
    lastProduct = products.find((product) => product.id === productId) || null;
    confirmed = Boolean(lastProduct && lastProduct.collections.some((collection) => collection.id === collectionId));
    if (!confirmed && attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  if (!confirmed) {
    appendAuditEvent(auditTracker, {
      type: 'error',
      specialistId: specialistId === undefined ? null : specialistId,
      status: 'error',
      summary: `Shopify collection membership update for '${contentReference}' mutated, but an independent re-read after ${maxAttempts} attempt(s) does not show product '${productId}' in collection '${collectionId}'.`,
      detail: { platform: PLATFORM, destination: DESTINATION, approval_id: requestId, reread_collections: lastProduct ? lastProduct.collections : null },
    });
    return {
      succeeded: false,
      status: 'unconfirmed',
      reason: `Shopify accepted the mutation, but an independent re-read does not show the expected collection membership after ${maxAttempts} attempt(s).`,
      authorization,
      result,
    };
  }

  appendAuditEvent(auditTracker, {
    type: 'result',
    specialistId: specialistId === undefined ? null : specialistId,
    status: 'success',
    summary: `Shopify collection membership update SUCCEEDED and was independently re-read for '${contentReference}' under approval '${requestId}': product '${productId}' is now in collection '${collectionId}'.`,
    detail: { platform: PLATFORM, destination: DESTINATION, approval_id: requestId, result },
  });

  return { succeeded: true, status: 'added', reason: null, authorization, result };
}

module.exports = {
  PLATFORM,
  DESTINATION,
  addProductToFreeDesignsCollection,
};
