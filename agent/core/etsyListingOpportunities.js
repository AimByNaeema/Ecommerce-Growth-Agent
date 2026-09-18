'use strict';

// ETSY LISTING OPTIMIZATION OPPORTUNITIES - derived from one etsy_listing_data_retrieval
// result and from nothing else.
//
// WHAT THIS IS FOR. The etsy_listing_inspection capability
// (agent/core/specialistCapabilityRegistry.js) returns the shop's real listings, each already
// carrying the EXISTING compliance verdict for its current content and the product facts its
// own data does not establish (missing_facts, reported as NEEDS_INFORMATION by
// compliance/etsyComplianceInput.js). That is a page of records, not an answer. This module
// turns it into the answer the owner asked for: a short, ranked list of specific listings with
// the exact evidence behind each one.
//
// IT NEVER JUDGES AND IT NEVER INVENTS. Every opportunity below is either (a) a verdict the
// existing compliance engine already reached, (b) a fact that engine already reported as
// missing, or (c) a field Etsy returned empty. Nothing is scored, weighted, estimated or
// compared against a benchmark, and no Etsy platform limit is asserted anywhere - this project
// holds no structured Etsy listing limits, so claiming one ("13 tags") would be exactly the
// kind of invented fact the rest of this system refuses.
//
// WHAT ETSY DOES NOT GIVE US, STATED OUTRIGHT. Sales, revenue, conversion, impressions, search
// volume and demand are not retrievable: integrations/adapters/etsyReadAdapter.js declares
// getOrders and getCustomers unsupported, and no allowed endpoint in
// integrations/adapters/etsyReadClient.js reports shop statistics. They are listed as
// unavailable on every result rather than omitted, so their absence is visible instead of
// looking like nothing was found. A per-listing field Etsy returned as null is reported the
// same way - never defaulted to 0, which for a count would read as a real measurement.
//
// Pure and deterministic: no network, no model call, no state.

// Per-listing fields this project reads but Etsy does not always populate on the
// listings-by-shop response. Reported as unavailable when null - never as 0.
const OPTIONAL_LISTING_FIELDS = [
  { id: 'views', label: 'Listing views' },
  { id: 'num_favorers', label: 'Listing favourites' },
];

// Metrics no Etsy read in this project can retrieve at all, with the reason. Derived from the
// adapter's own declared-unsupported capabilities, not from a guess about Etsy's API.
const UNAVAILABLE_METRICS = [
  'sales',
  'revenue',
  'orders',
  'conversion_rate',
  'impressions',
  'search_volume',
  'demand',
];
const UNAVAILABLE_REASON =
  'Not retrievable from Etsy through this system: integrations/adapters/etsyReadAdapter.js declares getOrders and getCustomers unsupported, and no permitted endpoint in integrations/adapters/etsyReadClient.js reports shop statistics. Nothing is estimated in their place.';

const DEFAULT_OPPORTUNITY_LIMIT = 5;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function present(value) {
  return value !== null && value !== undefined && value !== '';
}

// The evidence for one listing, each item quoting a real value or a real engine output.
// An empty array means this listing shows no opportunity THIS DATA can support - which is a
// legitimate outcome, not a reason to reach for something weaker.
function evidenceFor(entry) {
  const listing = isPlainObject(entry.listing) ? entry.listing : {};
  const compliance = isPlainObject(entry.compliance) ? entry.compliance : {};
  const missing = Array.isArray(entry.missing_facts) ? entry.missing_facts : [];
  const evidence = [];

  // (a) A verdict the existing compliance engine already reached for this listing's CURRENT
  // content. Quoted, never re-judged here.
  if (present(compliance.status) && compliance.status !== 'PASS') {
    const reasons = Array.isArray(compliance.review_reasons) ? compliance.review_reasons : [];
    evidence.push(
      `Compliance verdict for the existing content is ${compliance.status}` +
        (reasons.length > 0 ? `: ${reasons.join('; ')}` : '.')
    );
  }

  // (b) Product facts this listing's own data does not establish - already reported as
  // NEEDS_INFORMATION by compliance/etsyComplianceInput.js, never inferred there or here.
  if (missing.length > 0) {
    evidence.push(`Listing data does not establish: ${missing.join(', ')} (reported NEEDS_INFORMATION, not inferred).`);
  }

  // (c) Fields Etsy returned empty. Emptiness is observable; no maximum or target is claimed.
  if (Array.isArray(listing.tags) && listing.tags.length === 0) {
    evidence.push('Etsy returned 0 tags for this listing.');
  }
  if (Array.isArray(listing.materials) && listing.materials.length === 0) {
    evidence.push('Etsy returned 0 materials for this listing.');
  }
  if (present(listing.description) && String(listing.description).trim().length === 0) {
    evidence.push('Etsy returned an empty description for this listing.');
  }

  return evidence;
}

// One line naming what the evidence supports - a restatement of the evidence, never a
// prediction of what fixing it would achieve (that would be an invented performance claim).
function opportunityFor(evidence) {
  const parts = [];
  if (evidence.some((item) => item.startsWith('Compliance verdict'))) parts.push('existing content needs compliance review');
  if (evidence.some((item) => item.startsWith('Listing data does not establish'))) parts.push('product facts are not stated in the listing');
  if (evidence.some((item) => /0 tags/.test(item))) parts.push('no tags are set');
  if (evidence.some((item) => /0 materials/.test(item))) parts.push('no materials are set');
  if (evidence.some((item) => /empty description/.test(item))) parts.push('the description is empty');
  return parts.length > 0 ? `Review this listing: ${parts.join('; ')}.` : null;
}

function unavailableFieldsFor(listing) {
  const unavailable = [];
  if (!present(listing.title)) unavailable.push({ id: 'title', label: 'Listing title', reason: 'Etsy returned no value.' });
  if (!present(listing.state)) unavailable.push({ id: 'state', label: 'Listing status', reason: 'Etsy returned no value.' });
  if (listing.is_digital_product === null || listing.is_digital_product === undefined) {
    unavailable.push({
      id: 'is_digital_product',
      label: 'Digital or physical',
      reason: "Etsy reported neither is_digital nor a recognised listing_type, so it is left undetermined rather than assumed.",
    });
  }
  for (const field of OPTIONAL_LISTING_FIELDS) {
    if (!present(listing[field.id])) {
      unavailable.push({ id: field.id, label: field.label, reason: 'Etsy did not return this field on the listings response.' });
    }
  }
  return unavailable;
}

// toolResult: the `result` of tools/etsyListingDataTool.js's runEtsyListingDataTool().
// Returns null when there is nothing to describe, so a caller can simply skip it.
function deriveEtsyListingOpportunities(toolResult, { limit = DEFAULT_OPPORTUNITY_LIMIT } = {}) {
  if (!isPlainObject(toolResult) || !Array.isArray(toolResult.listings)) return null;
  const entries = toolResult.listings.filter(isPlainObject);

  // DIGITAL ONLY WHEN THE DATA SUPPORTS IT. is_digital_product is derived by the read client
  // strictly from what Etsy said (is_digital, or listing_type 'download'/'physical'); it is
  // null when Etsy said neither. Restricting to digital listings is therefore done only when
  // at least one listing really is reported digital - otherwise every listing is considered
  // and the result says so, rather than silently filtering on an undetermined field.
  const digital = entries.filter((entry) => isPlainObject(entry.listing) && entry.listing.is_digital_product === true);
  const digitalFilterApplied = digital.length > 0;
  const considered = digitalFilterApplied ? digital : entries;

  const ranked = considered
    .map((entry) => {
      const listing = isPlainObject(entry.listing) ? entry.listing : {};
      const evidence = evidenceFor(entry);
      return {
        listing_id: present(listing.listing_id) ? listing.listing_id : null,
        title: present(listing.title) ? listing.title : null,
        state: present(listing.state) ? listing.state : null,
        is_digital_product: listing.is_digital_product === undefined ? null : listing.is_digital_product,
        url: present(listing.url) ? listing.url : null,
        opportunity: opportunityFor(evidence),
        evidence,
        unavailable: unavailableFieldsFor(listing),
      };
    })
    .filter((candidate) => candidate.evidence.length > 0 && candidate.opportunity)
    // Most-evidenced first. Stable beyond that: Etsy's own returned order decides ties, so the
    // ranking is reproducible and nothing is scored.
    .sort((a, b) => b.evidence.length - a.evidence.length);

  return {
    channel: present(toolResult.channel) ? toolResult.channel : null,
    considered: {
      listings_returned: entries.length,
      digital_filter_applied: digitalFilterApplied,
      listings_considered: considered.length,
      digital_filter_note: digitalFilterApplied
        ? 'Restricted to listings Etsy reported as digital (is_digital_product true).'
        : 'Not restricted to digital listings: Etsy reported no listing as digital, and an undetermined field is never filtered on.',
      pagination: isPlainObject(toolResult.pagination) ? toolResult.pagination : null,
    },
    aggregate_compliance_status: present(toolResult.aggregate_compliance_status) ? toolResult.aggregate_compliance_status : null,
    opportunities: ranked.slice(0, Math.max(0, limit)),
    unavailable_metrics: UNAVAILABLE_METRICS.map((id) => ({ id, reason: UNAVAILABLE_REASON })),
  };
}

module.exports = {
  DEFAULT_OPPORTUNITY_LIMIT,
  OPTIONAL_LISTING_FIELDS,
  UNAVAILABLE_METRICS,
  UNAVAILABLE_REASON,
  deriveEtsyListingOpportunities,
};
