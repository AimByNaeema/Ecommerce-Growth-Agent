'use strict';

// VENDOR CORRECTION REQUESTS - "Suggest changing the vendor of 'X' from 'A' to 'B'" and "Review the existing
// vendor correction for 'X' and show its proposed change and approval status".
//
// THE DEFECTS THIS CLOSES (manual production testing):
//   1. A vendor change request reached shopify_vendor_correction, but nothing read the product, the current
//      vendor or the new vendor out of the request, so the correction had no parameters, compliance could not be
//      evaluated and no approval was created.
//   2. A question about an EXISTING vendor correction was answered by the SEO proposal check, which only knows
//      SEO proposals - so the owner was shown unrelated pending SEO proposals.
//
// WHAT THIS MODULE DOES - structure, validation and lookups only. It reads no store, calls no model, writes
// nothing and grants nothing. agent/core/orchestratorExecutionContract.js reads the product through the gated
// Product read, and a proposal becomes an ordinary pending approval for shopify_vendor_correction through the
// existing approval path: compliance evaluated, the owner's signed decision required, and the correction runs
// only through integrations/approvedCorrectionDispatch.js with its provenance, execute-once, re-check and
// verification controls. Nothing here can change the store.
//
// NOTHING IS GUESSED. The product must match exactly one store product by its exact title; a stated current
// vendor must equal the store's; the new vendor must be a real, different value. Anything missing, ambiguous or
// inconsistent is a question back to the owner, and no approval is created.

const approvalStore = require('../../approvals/approvalStore');
const { tokens, verbClass, singularForm } = require('./objectiveInterpretation');
const { classifyRequestIntent } = require('./mutationIntent');

const TOOL_ID = 'shopify_vendor_correction';
const PROPOSAL_KIND = 'vendor_correction';
const PLATFORM = 'shopify';
// Shopify's product vendor field holds at most 255 characters.
const MAX_VENDOR_LENGTH = 255;
const MAX_LISTED = 10;

// Words that name the approval system's record of a correction, and the states it is described by.
const RECORD_WORDS = new Set(['correction', 'proposal', 'approval', 'request']);
const RECORD_STATE_WORDS = new Set(['existing', 'pending', 'approved', 'stored', 'previous', 'earlier', 'rejected', 'executed']);
const NEGATIONS = new Set(['not', 'never', "don't", 'dont', 'no', 'without']);
const OPENING_QUOTES = { '"': ['"', '”'], "'": ["'", '’'], '“': ['”', '"'], '‘': ['’', "'"] };

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function normalizeSpace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function lowerWords(text) {
  return tokens(text).map((token) => token.lower);
}

// Every quoted span, in order, with its position. A quote opens after a start, space or opening punctuation and
// closes before a space, punctuation or the end - so an apostrophe inside a name ("Mom's Clipart") is not a quote.
function quotedSpans(text) {
  const value = String(text || '');
  const spans = [];
  let index = 0;
  while (index < value.length) {
    const char = value[index];
    const opensHere = Object.prototype.hasOwnProperty.call(OPENING_QUOTES, char) && (index === 0 || /[\s(:,[]/.test(value[index - 1]));
    if (!opensHere) {
      index += 1;
      continue;
    }
    let close = -1;
    for (let cursor = index + 1; cursor < value.length; cursor += 1) {
      if (OPENING_QUOTES[char].includes(value[cursor]) && (cursor + 1 === value.length || /[\s.,;:!?)\]]/.test(value[cursor + 1]))) {
        close = cursor;
        break;
      }
    }
    if (close < 0) {
      index += 1;
      continue;
    }
    const inner = value.slice(index + 1, close);
    if (inner.trim()) spans.push({ start: index, end: close + 1, text: normalizeSpace(inner) });
    index = close + 1;
  }
  return spans;
}

// The sentence that names the vendor.
function vendorSentence(text) {
  const sentences = String(text || '').split(/(?<=[.!?;])\s+(?=[A-Z"'“‘])|\n+/);
  return sentences.find((sentence) => lowerWords(sentence).some((word) => singularForm(word) === 'vendor')) || null;
}

// What a vendor request states: { mentions_vendor, product_name, from_vendor, to_vendor, quoted }.
// Quoted values are read exactly as typed. Without quotes, only the explicit shape
// "vendor of|for|on <product> from <current> to <new>" is read.
function parseVendorChange(objective) {
  const sentence = vendorSentence(objective);
  const empty = { mentions_vendor: false, product_name: null, from_vendor: null, to_vendor: null, quoted: false };
  if (!sentence) return empty;
  const spans = quotedSpans(sentence);
  const result = { ...empty, mentions_vendor: true, quoted: spans.length > 0 };
  if (spans.length > 0) {
    let previousEnd = 0;
    for (const span of spans) {
      const before = sentence.slice(previousEnd, span.start);
      if (/\bfrom\s*$/i.test(before) && !result.from_vendor) result.from_vendor = span.text;
      else if (/\b(?:to|into|as)\s*$/i.test(before) && !result.to_vendor) result.to_vendor = span.text;
      else if (!result.product_name) result.product_name = span.text;
      previousEnd = span.end;
    }
    return result;
  }
  const shaped = sentence.match(/\bvendors?\s+(?:of|for|on)\s+(?:the\s+)?(.+?)\s+(?:product\s+)?from\s+(.+?)\s+to\s+(.+?)\s*[.!?]?\s*$/i);
  if (shaped) {
    result.product_name = normalizeSpace(shaped[1]);
    result.from_vendor = normalizeSpace(shaped[2]);
    result.to_vendor = normalizeSpace(shaped[3]);
  }
  return result;
}

function sentencesOf(text) {
  return String(text || '').split(/(?<=[.!?;])\s+|\n+/).map(normalizeSpace).filter(Boolean);
}

// Whether a negation governs the change in the vendor sentence ("Do not change the vendor ...").
function negatedChange(sentence) {
  const words = lowerWords(sentence);
  const changeAt = words.findIndex((word) => ['change', 'changing', 'set', 'setting', 'update', 'updating', 'correct', 'correcting', 'fix', 'fixing', 'rename', 'renaming', 'replace', 'replacing', 'switch', 'switching', 'suggest', 'propose', 'recommend'].includes(word));
  if (changeAt < 0) return false;
  return words.slice(Math.max(0, changeAt - 3), changeAt).some((word) => NEGATIONS.has(word));
}

// DOES THIS OBJECTIVE ASK ABOUT A VENDOR CORRECTION, AND WHICH KIND?
//   { kind: 'propose' } - it states a new vendor for a product: a change to propose for the owner's approval.
//   { kind: 'review' }  - it asks to see an existing vendor correction (its change and approval status).
//   { kind: null }      - neither; routing continues unchanged.
// `additional_requests` are clauses routed to another specialist - never silently dropped.
function decideVendorCorrection({ objective, routingResult = null } = {}) {
  const parsed = parseVendorChange(objective);
  if (!parsed.mentions_vendor) return { kind: null, parsed };
  const sentence = vendorSentence(objective);
  const words = lowerWords(objective);
  const interpretation = asArray(routingResult && routingResult.interpretation).filter((entry) => entry && isNonEmptyString(entry.clause));
  const additional = interpretation
    .filter((entry) => entry.disposition === 'task' && entry.target && entry.target !== 'product')
    .filter((entry) => !lowerWords(entry.clause).some((word) => singularForm(word) === 'vendor'))
    .map((entry) => entry.clause);

  // A stated new vendor, or a named product with an explicit instruction to change it (whose missing new vendor is
  // then asked for, never guessed).
  const asksToChange = parsed.to_vendor || (parsed.product_name && classifyRequestIntent(objective) === 'mutation');
  if (asksToChange && !negatedChange(sentence)) {
    return { kind: 'propose', parsed, additional_requests: additional };
  }

  const namesRecord = words.some((word) => RECORD_WORDS.has(singularForm(word))) && (words.some((word) => RECORD_STATE_WORDS.has(word)) || /\bapr-\d+\b/.test(objective));
  const readLed = sentencesOf(objective).some((text) => {
    const lead = lowerWords(text).find((word) => !['please', 'can', 'could', 'you', 'now', 'and', 'also', 'then'].includes(word));
    return Boolean(lead) && (verbClass(lead) === 'read' || ['what', 'which', 'is', 'has', 'was', 'where'].includes(lead));
  });
  if (namesRecord && readLed && !parsed.to_vendor) {
    return { kind: 'review', parsed, additional_requests: additional };
  }
  return { kind: null, parsed };
}

// A new vendor value that may be proposed: { ok, value, reason }.
function validateNewVendor(value, currentVendor) {
  if (!isNonEmptyString(value)) return { ok: false, reason: 'No new vendor value was stated.' };
  const trimmed = value.trim();
  if (trimmed.length > MAX_VENDOR_LENGTH) return { ok: false, reason: `The new vendor is ${trimmed.length} characters; Shopify allows at most ${MAX_VENDOR_LENGTH}.` };
  // eslint-disable-next-line no-control-regex
  if (/[ -]/.test(trimmed)) return { ok: false, reason: 'The new vendor contains control characters.' };
  if (typeof currentVendor === 'string' && currentVendor.trim() === trimmed) {
    return { ok: false, reason: `The product's vendor is already "${trimmed}", so there is nothing to change.` };
  }
  return { ok: true, value: trimmed, reason: null };
}

// The ONE store product a name identifies, by exact title (case and spacing ignored). Listing sources are
// tools/productDataRetrievalTool.js's listing_sources. Returns { status: 'resolved', product } or
// { status: 'not_found' | 'ambiguous', candidates }.
function resolveStoreProduct(listingSources, productName) {
  const key = normalizeSpace(productName).toLowerCase();
  const products = asArray(listingSources)
    .filter((source) => source && isNonEmptyString(source.shopify_product_id))
    .map((source) => ({
      product_id: source.shopify_product_id,
      title: source.product_reference || source.title || '',
      vendor: source.store_fields && Object.prototype.hasOwnProperty.call(source.store_fields, 'vendor') && !asArray(source.store_fields.unavailable_fields).includes('vendor')
        ? source.store_fields.vendor
        : null,
    }));
  const exact = products.filter((product) => normalizeSpace(product.title).toLowerCase() === key);
  if (exact.length === 1) return { status: 'resolved', product: exact[0] };
  if (exact.length > 1) return { status: 'ambiguous', candidates: exact.slice(0, MAX_LISTED) };
  const nameWords = lowerWords(productName);
  const similar = products.filter((product) => {
    const title = new Set(lowerWords(product.title));
    return nameWords.length > 0 && nameWords.every((word) => title.has(word));
  });
  return { status: 'not_found', candidates: similar.slice(0, MAX_LISTED) };
}

// Every stored vendor correction for this business, newest first, described exactly as stored.
function listStoredVendorCorrections({ businessId = null, storeDir = undefined, now = new Date() } = {}) {
  const tenant = isNonEmptyString(businessId) ? businessId.trim() : null;
  const corrections = [];
  for (const envelope of approvalStore.listStoredApprovals(storeDir ? { storeDir } : {})) {
    if ((envelope.business_id || null) !== tenant) continue;
    const request = envelope.approval_request || {};
    if (request.tool_id !== TOOL_ID) continue;
    const executionRequest = request.execution_request && typeof request.execution_request === 'object' ? request.execution_request : {};
    const params = executionRequest.research_params && typeof executionRequest.research_params === 'object' ? executionRequest.research_params : {};
    const expired = Boolean(envelope.expires_at) && new Date(envelope.expires_at).getTime() <= new Date(now).getTime();
    corrections.push({
      approval_id: request.id,
      approval_status: request.status,
      execution_state: envelope.execution_state,
      expired,
      requested_at: request.requested_at || null,
      decided_at: request.decided_at || null,
      stored_at: envelope.stored_at || null,
      executed_at: envelope.executed_at || null,
      expires_at: envelope.expires_at || null,
      product_id: isNonEmptyString(params.productId) ? params.productId : null,
      product_reference: isNonEmptyString(params.productReference) ? params.productReference : null,
      // The vendor the store showed when the correction was proposed - null when the record did not store it.
      current_vendor_at_proposal: typeof params.currentVendor === 'string' ? params.currentVendor : null,
      new_vendor: typeof params.newVendor === 'string' ? params.newVendor : null,
      store_reference: isNonEmptyString(params.storeReference) ? params.storeReference : null,
      compliance_status: executionRequest.compliance && typeof executionRequest.compliance.compliance_status === 'string' ? executionRequest.compliance.compliance_status : null,
    });
  }
  return corrections.sort((a, b) => String(b.stored_at).localeCompare(String(a.stored_at)));
}

// A stored correction that can still lead to a change: not rejected, cancelled, executed or expired.
function isOpenCorrection(correction) {
  return ['pending', 'approved'].includes(correction.approval_status) && !['executed', 'cancelled'].includes(correction.execution_state) && !correction.expired;
}

module.exports = {
  TOOL_ID,
  PROPOSAL_KIND,
  PLATFORM,
  MAX_VENDOR_LENGTH,
  quotedSpans,
  parseVendorChange,
  decideVendorCorrection,
  validateNewVendor,
  resolveStoreProduct,
  listStoredVendorCorrections,
  isOpenCorrection,
};
