'use strict';

// The Shopify product SEO update - applying an SEO proposal the owner has already been shown, shaped
// exactly like integrations/shopifyVendorCorrection.js:
//
//   Existing proposal -> Compliance -> Human Approval -> Publish Authorization -> Shopify productUpdate
//   -> independent re-read
//
// WHERE ITS VALUES COME FROM. Never from a request's wording and never from a model. Every value it
// writes is a before/after pair agent/core/seoChangeProposal.js already derived from the product's own
// stored text and put in front of the owner as a pending approval. verifySeoProposalSource below
// re-reads that proposal from DURABLE approval state and refuses any request whose product, field,
// before or after value is not exactly the proposal's - when the Chief creates the approval, and again
// immediately before execution. A proposal the owner rejected or that was cancelled authorizes nothing.
//
// ONLY THE APPROVED SEO FIELDS CHANGE. shopifyClient.updateProductSeo() sends only id + seo, and it is
// called once, after authorization. A field the approval does not name is sent at the value read from
// the store immediately before, so it cannot be cleared. If the store no longer shows the value the
// proposal was made from, nothing is written (status 'stale') - an approval of "before -> after" is never
// applied over a value the owner did not see.
//
// VERIFIED, NOT ASSUMED. After the mutation the product is re-read with a separate query. The result is
// 'applied' only when every approved field shows exactly the approved value AND every other SEO and
// product field (title, handle, description, status, vendor, product type, tags) is unchanged from the
// read taken before the write. Anything else is 'unconfirmed' and never reported as a success.

const shopifyClient = require('./adapters/shopifyClient');
const approvalStore = require('../approvals/approvalStore');
const { authorizePublishing } = require('../approvals/publishAuthorization');
const { appendAuditEvent } = require('../audit/auditTrail');

const PLATFORM = 'shopify';
const DESTINATION = 'product_seo';
const TOOL_ID = 'shopify_product_seo_update';

// The proposal record this applies - agent/core/seoChangeProposal.js's PROPOSAL_KIND and
// PROPOSAL_TOOL_ID, restated rather than required so this integration loads nothing from agent/core
// (verification/testing/proposalExecution.test.js pins that the two stay equal).
const SOURCE_PROPOSAL_KIND = 'seo_metadata';
const SOURCE_PROPOSAL_TOOL_ID = 'seo_quality_check';
// Proposal approvals that can still be applied. A rejected one cannot.
const APPLICABLE_SOURCE_STATUSES = ['pending', 'approved'];

// The SEO fields this integration can write: the proposal's own shopify_field names, the name the
// proposal and audit use for each, and the key each is compared under after a re-read.
const SEO_FIELDS = {
  'seo.title': { field: 'meta_title', observed: 'seo_title', label: 'SEO title' },
  'seo.description': { field: 'meta_description', observed: 'seo_description', label: 'meta description' },
};

// Product fields an SEO update must leave exactly as they were.
const UNCHANGED_PRODUCT_FIELDS = ['title', 'handle', 'description', 'status', 'vendor', 'product_type', 'tags'];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function collapse(text) {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
}

function normalizeBusinessId(businessId) {
  return isNonEmptyString(businessId) ? businessId.trim() : null;
}

// One product, as this update compares it. An SEO field Shopify reports as null (no custom value) is
// ''. Only fields the read genuinely returned are projected; nothing is filled in.
function projectProduct(product) {
  const safe = isPlainObject(product) ? product : {};
  const seo = isPlainObject(safe.seo) ? safe.seo : {};
  return {
    seo_title: typeof seo.title === 'string' ? seo.title : '',
    seo_description: typeof seo.description === 'string' ? seo.description : '',
    title: safe.title === undefined ? null : safe.title,
    handle: safe.handle === undefined ? null : safe.handle,
    description: safe.description === undefined ? null : safe.description,
    status: safe.status === undefined ? null : safe.status,
    vendor: safe.vendor === undefined ? null : safe.vendor,
    product_type: safe.productType === undefined ? null : safe.productType,
    tags: Array.isArray(safe.tags) ? [...safe.tags] : null,
  };
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// The approved changes, validated: a non-empty list of distinct SEO fields, each with the value it was
// proposed from and a non-empty value that differs from it.
function validateAppliedChanges(appliedChanges) {
  if (!Array.isArray(appliedChanges) || appliedChanges.length === 0) {
    return { ok: false, reason: 'No SEO change is stated.', changes: [] };
  }
  const seen = new Set();
  const changes = [];
  for (const change of appliedChanges) {
    if (!isPlainObject(change) || !Object.prototype.hasOwnProperty.call(SEO_FIELDS, change.shopify_field)) {
      return { ok: false, reason: `Only ${Object.keys(SEO_FIELDS).join(' and ')} can be applied here.`, changes: [] };
    }
    if (seen.has(change.shopify_field)) {
      return { ok: false, reason: `${change.shopify_field} is stated more than once.`, changes: [] };
    }
    if (typeof change.before !== 'string' || !isNonEmptyString(change.after) || collapse(change.after) === collapse(change.before)) {
      return { ok: false, reason: `${change.shopify_field} does not state a before value and a different, non-empty after value.`, changes: [] };
    }
    seen.add(change.shopify_field);
    changes.push({ shopify_field: change.shopify_field, field: SEO_FIELDS[change.shopify_field].field, before: change.before, after: change.after });
  }
  return { ok: true, reason: null, changes };
}

// IS THIS REQUEST EXACTLY AN EXISTING PROPOSAL? Read from durable approval state only.
//
// Returns { ok, reason_code, reason, source } - `source` is the stored proposal envelope when ok. The
// business must match exactly (a null business matches only unscoped records), so one business can
// never apply another's proposal.
function verifySeoProposalSource(executionRequest, { storeDir = undefined, now = new Date() } = {}) {
  const refuse = (reasonCode, reason) => ({ ok: false, reason_code: reasonCode, reason, source: null });
  const request = isPlainObject(executionRequest) ? executionRequest : {};
  const params = isPlainObject(request.research_params) ? request.research_params : {};
  const businessId = normalizeBusinessId(request.business_id);

  if (!isNonEmptyString(params.sourceApprovalId)) {
    return refuse('source_not_named', 'The request names no existing SEO proposal approval, so there is nothing it may apply.');
  }
  if (!isNonEmptyString(params.productId)) {
    return refuse('product_not_named', 'The request names no product.');
  }
  const checked = validateAppliedChanges(params.appliedChanges);
  if (!checked.ok) return refuse('changes_invalid', checked.reason);

  const envelope = approvalStore.loadApprovalRecord(params.sourceApprovalId, storeDir ? { storeDir } : {});
  if (!envelope || (envelope.business_id || null) !== businessId) {
    return refuse('source_not_found', `No stored SEO proposal '${params.sourceApprovalId}' exists for this business.`);
  }
  const source = envelope.approval_request;
  const sourceParams = isPlainObject(source.execution_request) && isPlainObject(source.execution_request.research_params)
    ? source.execution_request.research_params
    : {};
  if (source.tool_id !== SOURCE_PROPOSAL_TOOL_ID || sourceParams.proposal_kind !== SOURCE_PROPOSAL_KIND) {
    return refuse('source_not_a_proposal', `Approval '${params.sourceApprovalId}' is not an SEO change proposal.`);
  }
  if (envelope.execution_state === 'cancelled' || !APPLICABLE_SOURCE_STATUSES.includes(source.status)) {
    return refuse('source_withdrawn', `SEO proposal '${params.sourceApprovalId}' is ${envelope.execution_state === 'cancelled' ? 'cancelled' : `'${source.status}'`}, so it cannot be applied.`);
  }
  if (envelope.expires_at && new Date(envelope.expires_at).getTime() <= new Date(now).getTime()) {
    return refuse('source_expired', `SEO proposal '${params.sourceApprovalId}' has expired.`);
  }
  if (isNonEmptyString(sourceParams.platform) && sourceParams.platform !== PLATFORM) {
    return refuse('source_other_platform', `SEO proposal '${params.sourceApprovalId}' is for ${sourceParams.platform}, not Shopify.`);
  }
  if (String(sourceParams.shopify_product_id || '') !== params.productId) {
    return refuse('source_other_product', `SEO proposal '${params.sourceApprovalId}' is for a different product.`);
  }
  if (isNonEmptyString(sourceParams.store_reference) && params.storeReference !== sourceParams.store_reference) {
    return refuse('source_other_store', `SEO proposal '${params.sourceApprovalId}' was made for a different store.`);
  }
  const proposed = Array.isArray(sourceParams.proposed_changes) ? sourceParams.proposed_changes.filter(isPlainObject) : [];
  for (const change of checked.changes) {
    const match = proposed.find((entry) => entry.shopify_field === change.shopify_field);
    if (!match) {
      return refuse('change_not_proposed', `SEO proposal '${params.sourceApprovalId}' proposes no ${change.shopify_field} change.`);
    }
    if (collapse(match.before) !== collapse(change.before) || match.after !== change.after) {
      return refuse('change_differs_from_proposal', `The ${change.shopify_field} value differs from what SEO proposal '${params.sourceApprovalId}' proposed.`);
    }
  }
  return { ok: true, reason_code: null, reason: null, source: envelope };
}

// Applies one already-authorized SEO change set to the live store, then independently re-reads it.
//
//   requests         - the SERVER-HELD approval requests array. Required.
//   requestId        - which approval to consult. A lookup key only.
//   contentReference - the entity being authorized. Matched against the approval.
//   productId        - the product's gid://shopify/Product/... id. Required.
//   appliedChanges   - [{ shopify_field, before, after }] from the approved request.
//   specialistId     - optional, forwarded to the permission re-check.
//   businessId       - optional, selects that business's own Shopify credentials.
//   auditTracker     - optional; the attempt, result and re-read are all recorded.
//
// Returns { succeeded, status, reason, authorization, result, baseline, observed }.
//   'refused'     - not authorized, invalid, or the product was not found. NO mutation made.
//   'stale'       - the store no longer shows the proposal's before value. NO mutation made.
//   'failed'      - the read before, or the client's mutation, failed.
//   'unconfirmed' - the mutation was accepted, but the re-read does not show exactly the approved
//                   values with everything else unchanged. Never a success.
//   'applied'     - authorized, written, and independently re-read as exactly approved.
async function applyApprovedProductSeo({
  requests,
  requestId,
  contentReference,
  productId,
  appliedChanges,
  specialistId = 'product',
  businessId = null,
  auditTracker = null,
} = {}) {
  if (!Array.isArray(requests)) {
    throw new Error(
      'applyApprovedProductSeo requires the server-held `requests` array. It never accepts an approval record, an approval status, or an authorization result from a caller.'
    );
  }
  const detail = (extra = {}) => ({ platform: PLATFORM, destination: DESTINATION, approval_id: requestId || null, ...extra });
  const finish = (status, reason, extra = {}) => ({ succeeded: false, status, reason, result: null, baseline: null, observed: null, ...extra });

  const authorization = authorizePublishing({ requests, requestId, contentReference, specialistId, auditTracker });
  if (!authorization.authorized) {
    appendAuditEvent(auditTracker, {
      type: 'execution',
      specialistId,
      status: 'refused',
      summary: `Shopify SEO update REFUSED for '${contentReference || '(no content reference)'}' - not authorized (${authorization.failed_check}). No Shopify call was made.`,
      detail: detail({ failed_check: authorization.failed_check }),
    });
    return finish('refused', authorization.reason, { authorization });
  }

  const checked = validateAppliedChanges(appliedChanges);
  if (!isNonEmptyString(productId) || !checked.ok) {
    const reason = `Nothing was updated: ${!isNonEmptyString(productId) ? 'no productId is stated' : checked.reason} Nothing is substituted or invented.`;
    appendAuditEvent(auditTracker, { type: 'error', specialistId, status: 'error', summary: `Shopify SEO update REFUSED for '${contentReference}' - ${reason} No Shopify call was made.`, detail: detail() });
    return finish('refused', reason, { authorization });
  }

  // The store's current values, read immediately before the write.
  let current;
  try {
    const products = await shopifyClient.getProducts({ limit: 250, businessId });
    current = products.find((product) => product.id === productId) || null;
  } catch (err) {
    appendAuditEvent(auditTracker, { type: 'error', specialistId, status: 'failed', summary: `Shopify SEO update for '${contentReference}' could not read the product's current values, so nothing was written: ${err.message}`, detail: detail() });
    return finish('failed', `The product's current values could not be read, so nothing was written: ${err.message}`, { authorization });
  }
  if (!current) {
    const reason = `Product '${productId}' was not found in the store, so nothing was written.`;
    appendAuditEvent(auditTracker, { type: 'error', specialistId, status: 'refused', summary: `Shopify SEO update REFUSED for '${contentReference}': ${reason}`, detail: detail() });
    return finish('refused', reason, { authorization });
  }
  const baseline = projectProduct(current);

  const stale = checked.changes.filter((change) => collapse(baseline[SEO_FIELDS[change.shopify_field].observed]) !== collapse(change.before));
  if (stale.length > 0) {
    const described = stale
      .map((change) => `${change.shopify_field} is now "${baseline[SEO_FIELDS[change.shopify_field].observed]}", not the "${change.before}" the proposal was made from`)
      .join('; ');
    const reason = `The store changed since the proposal: ${described}. Nothing was written.`;
    appendAuditEvent(auditTracker, { type: 'error', specialistId, status: 'refused', summary: `Shopify SEO update REFUSED for '${contentReference}': ${reason}`, detail: detail() });
    return finish('stale', reason, { authorization, baseline });
  }

  // Both SEO fields are sent: approved ones at their approved value, the other at its current value.
  const values = {
    'seo.title': isPlainObject(current.seo) && typeof current.seo.title === 'string' ? current.seo.title : null,
    'seo.description': isPlainObject(current.seo) && typeof current.seo.description === 'string' ? current.seo.description : null,
  };
  for (const change of checked.changes) values[change.shopify_field] = change.after;

  appendAuditEvent(auditTracker, {
    type: 'execution',
    specialistId,
    status: 'attempted',
    summary:
      `Shopify SEO update ATTEMPTED for '${contentReference}' under approval '${requestId}' (compliance ${authorization.compliance_status}): product '${productId}' - ` +
      checked.changes.map((change) => `${change.shopify_field} "${change.before}" -> "${change.after}"`).join('; ') + '.',
    detail: detail({ decided_by: authorization.approval.decided_by, product_id: productId, changes: checked.changes }),
  });

  let result;
  try {
    result = await shopifyClient.updateProductSeo({ productId, seoTitle: values['seo.title'], seoDescription: values['seo.description'], businessId });
  } catch (err) {
    appendAuditEvent(auditTracker, { type: 'error', specialistId, status: 'failed', summary: `Shopify SEO update FAILED for '${contentReference}': ${err.message}`, detail: detail() });
    return finish('failed', err.message, { authorization, baseline });
  }

  // Independent re-read: a fresh query, never the mutation's echoed response alone.
  let reread;
  try {
    const products = await shopifyClient.getProducts({ limit: 250, businessId });
    reread = products.find((product) => product.id === productId) || null;
  } catch (err) {
    appendAuditEvent(auditTracker, { type: 'error', specialistId, status: 'error', summary: `Shopify SEO update for '${contentReference}' was accepted, but the independent re-read failed: ${err.message}`, detail: detail() });
    return finish('unconfirmed', `Written, but could not independently re-read: ${err.message}`, { authorization, result, baseline });
  }
  if (!reread) {
    const reason = `Shopify accepted the update, but product '${productId}' was not found on the re-read.`;
    appendAuditEvent(auditTracker, { type: 'error', specialistId, status: 'error', summary: `Shopify SEO update for '${contentReference}': ${reason}`, detail: detail() });
    return finish('unconfirmed', reason, { authorization, result, baseline });
  }

  const observed = projectProduct(reread);
  const problems = [];
  for (const change of checked.changes) {
    const key = SEO_FIELDS[change.shopify_field].observed;
    if (observed[key] !== change.after) problems.push(`${change.shopify_field} shows "${observed[key]}", not "${change.after}"`);
  }
  const approvedKeys = new Set(checked.changes.map((change) => SEO_FIELDS[change.shopify_field].observed));
  const mustNotChange = [...Object.values(SEO_FIELDS).map((entry) => entry.observed).filter((key) => !approvedKeys.has(key)), ...UNCHANGED_PRODUCT_FIELDS];
  for (const key of mustNotChange) {
    if (!sameValue(observed[key], baseline[key])) problems.push(`${key} changed although it was not approved`);
  }
  if (problems.length > 0) {
    const reason = `Shopify accepted the update, but the independent re-read does not match: ${problems.join('; ')}.`;
    appendAuditEvent(auditTracker, { type: 'error', specialistId, status: 'error', summary: `Shopify SEO update for '${contentReference}': ${reason}`, detail: detail() });
    return finish('unconfirmed', reason, { authorization, result, baseline, observed });
  }

  appendAuditEvent(auditTracker, {
    type: 'result',
    specialistId,
    status: 'success',
    summary:
      `Shopify SEO update SUCCEEDED and was independently re-read for '${contentReference}' under approval '${requestId}': product '${productId}' now shows ` +
      checked.changes.map((change) => `${change.shopify_field} "${change.after}"`).join('; ') + ', with no other field changed.',
    detail: detail({ product_id: productId, observed: checked.changes.map((change) => ({ shopify_field: change.shopify_field, value: observed[SEO_FIELDS[change.shopify_field].observed] })) }),
  });
  return { succeeded: true, status: 'applied', reason: null, authorization, result, baseline, observed };
}

module.exports = {
  PLATFORM,
  DESTINATION,
  TOOL_ID,
  SOURCE_PROPOSAL_KIND,
  SOURCE_PROPOSAL_TOOL_ID,
  APPLICABLE_SOURCE_STATUSES,
  SEO_FIELDS,
  UNCHANGED_PRODUCT_FIELDS,
  projectProduct,
  validateAppliedChanges,
  verifySeoProposalSource,
  applyApprovedProductSeo,
};
