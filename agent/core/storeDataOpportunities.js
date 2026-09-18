'use strict';

// STORE-DATA OPPORTUNITIES - derived from what a growth cycle already read, and from nothing
// else.
//
// WHAT THIS IS FOR. A growth cycle now reads both stores and reports what each specialist
// found, but a list of findings is not an answer to "find the highest-confidence opportunities,
// explain the evidence, propose actions". This turns the records already in the run into
// specific, evidenced opportunities - per platform, each with the real field state behind it,
// a proposed action for the owner, a confidence grounded in that evidence, and whether acting
// on it would need approval.
//
// ONLY A FIELD THAT WAS GENUINELY READ CAN BE ASSESSED, AND THIS IS THE WHOLE DIFFICULTY.
// tools/productDataRetrievalTool.js's mapShopifyProductToCandidate() hardcodes
// pricing.cost: '' and pricing.currency: '' - it never asks Shopify for them - and
// agent/core/productModel.js has no description field, so a product record's empty
// description says nothing about the store either. Reporting any of those as a gap would be
// inventing a problem out of this project's own mapping. They are declared in not_assessed
// with the reason instead. The fields below are the ones the read really carries:
//
//   Shopify product record - category (Shopify's productType), availability (its status) and
//     price (the first variant's). Everything else about a product is not assessable here.
//   Etsy shop record - is_vacation, and the listing counts. normalizeEtsyShop() returns null
//     for a field Etsy did not return, so null is "not established", never "empty" - only a
//     value Etsy actually sent is treated as a fact.
//
// NO IMPACT ESTIMATE, AND THEREFORE NOT agent/core/growthOpportunityEngine.js. That engine
// ranks by expected_impact_magnitude, which it requires the caller to supply and explicitly
// refuses to guess ("a business-impact size estimate cannot be silently invented"). Nothing in
// a store read establishes one, so no candidate here could be fed to it honestly. These
// opportunities are ordered by how much real evidence each rests on, and carry no impact
// estimate at all.
//
// NOTHING ABOUT SALES IS PRODUCED. Sales, revenue, orders, conversion, impressions, search
// volume and demand are never computed, estimated or implied here; where a step's own result
// declares a limitation (a capped read, for example) that limitation is relayed verbatim as a
// limit on the evidence rather than reasoned past.
//
// PURE AND READ-ONLY: no network, no model call, no state, no tool call. It reads the plan the
// Chief already produced.

const { CONFIDENCE_LEVELS } = require('./researchRecordModel');

// Fields a Shopify product record cannot speak to, with the reason. Declared so their silence
// is visible instead of being read as a finding.
const SHOPIFY_PRODUCT_NOT_ASSESSED = [
  {
    field: 'unit_cost',
    reason:
      "Not read: tools/productDataRetrievalTool.js's mapShopifyProductToCandidate() sets pricing.cost to '' without asking Shopify for it, so an empty cost says nothing about the store.",
  },
  {
    field: 'currency',
    reason: "Not read: pricing.currency is set to '' by the same mapping, not retrieved.",
  },
  {
    field: 'description',
    reason:
      'Not carried: agent/core/productModel.js has no description field, so this record cannot show whether the store has one.',
  },
  {
    field: 'margin',
    reason: 'Not computable: no unit cost is read, and a margin is never estimated from a price alone.',
  },
];

const ETSY_SHOP_NOT_ASSESSED = [
  {
    field: 'sales, revenue, orders, conversion, impressions, search volume, demand',
    reason:
      'Not retrievable from Etsy through this system: integrations/adapters/etsyReadAdapter.js declares getOrders and getCustomers unsupported, and no permitted endpoint reports shop statistics. Nothing is estimated in their place.',
  },
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function str(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

// An opportunity is only ever built from evidence already collected. Confidence is a statement
// about THAT evidence, never about a business outcome: 'high' when it rests on a field value
// the read actually returned, and the honesty guard the rest of this project uses applies -
// no evidence means 'unassessed', whatever else is true.
function opportunity({ platform, issue, evidence, proposedAction, requiresApproval, notAssessed = [], confidence = 'high' }) {
  const lines = (evidence || []).filter(Boolean);
  const level = lines.length === 0 ? 'unassessed' : confidence;
  if (!CONFIDENCE_LEVELS.includes(level)) throw new Error(`Unknown confidence level '${level}'.`);
  return {
    platform,
    issue,
    evidence: lines,
    proposed_action: proposedAction,
    confidence: level,
    // Acting on any of these changes a store, and this project never does that without the
    // owner's approval. Producing the recommendation needs none; carrying it out does.
    requires_approval: requiresApproval,
    not_assessed: notAssessed,
  };
}

// --- Shopify product records ---------------------------------------------------------------

function shopifyProductOpportunities(records) {
  const products = records.filter(isPlainObject);
  if (products.length === 0) return [];
  const named = (record) => str(record.product_identity) || str(record.title) || 'an unnamed product';

  const missingCategory = products.filter((record) => !str(record.category));
  const notActive = products.filter((record) => str(record.availability) && record.availability !== 'available');
  const missingPrice = products.filter((record) => !isPlainObject(record.pricing) || !str(record.pricing.price));

  const found = [];
  if (missingCategory.length > 0) {
    found.push(
      opportunity({
        platform: 'shopify',
        issue: `${missingCategory.length} of ${products.length} product(s) have no product type set in Shopify.`,
        evidence: [
          `Shopify returned an empty productType for: ${missingCategory.map(named).join('; ')}.`,
          ...missingCategory.flatMap((record) => (Array.isArray(record.source) ? record.source.filter(Boolean).slice(0, 1) : [])),
        ],
        proposedAction: 'Set a product type on each of those products in Shopify so they can be grouped, filtered and merchandised.',
        requiresApproval: true,
        notAssessed: SHOPIFY_PRODUCT_NOT_ASSESSED,
      })
    );
  }
  if (notActive.length > 0) {
    found.push(
      opportunity({
        platform: 'shopify',
        issue: `${notActive.length} of ${products.length} product(s) are not available to buy.`,
        evidence: notActive.map((record) => `${named(record)}: availability "${record.availability}" (from the Shopify product status).`),
        proposedAction: 'Review each of those products and publish it, or confirm it is meant to stay unavailable.',
        requiresApproval: true,
        notAssessed: SHOPIFY_PRODUCT_NOT_ASSESSED,
      })
    );
  }
  if (missingPrice.length > 0) {
    found.push(
      opportunity({
        platform: 'shopify',
        issue: `${missingPrice.length} of ${products.length} product(s) returned no price on their first variant.`,
        evidence: missingPrice.map((record) => `${named(record)}: no price on the first variant returned by the store read.`),
        proposedAction: 'Check those products in Shopify and set a price, or confirm the variant is intentionally unpriced.',
        requiresApproval: true,
        notAssessed: SHOPIFY_PRODUCT_NOT_ASSESSED,
      })
    );
  }
  return found;
}

// --- Etsy shop record ------------------------------------------------------------------------

function etsyShopOpportunities(shop) {
  if (!isPlainObject(shop)) return [];
  const found = [];
  const name = str(shop.shop_name) || 'this Etsy shop';

  // Only a value Etsy actually sent is a fact. null means Etsy did not report it.
  if (shop.is_vacation === true) {
    found.push(
      opportunity({
        platform: 'etsy',
        issue: `${name} is in vacation mode, so its listings are not purchasable.`,
        evidence: [`Etsy returned is_vacation: true for shop ${shop.shop_id}.`],
        proposedAction: 'Turn vacation mode off in Etsy if the shop is meant to be open.',
        requiresApproval: true,
        notAssessed: ETSY_SHOP_NOT_ASSESSED,
      })
    );
  }

  const active = Number.isFinite(shop.listing_active_count) ? shop.listing_active_count : null;
  const digital = Number.isFinite(shop.digital_listing_count) ? shop.digital_listing_count : null;
  if (active === 0) {
    found.push(
      opportunity({
        platform: 'etsy',
        issue: `${name} has no active listings.`,
        evidence: [`Etsy returned listing_active_count: 0 for shop ${shop.shop_id}.`],
        proposedAction: 'Publish at least one listing in Etsy, or confirm the shop is intentionally empty.',
        requiresApproval: true,
        notAssessed: ETSY_SHOP_NOT_ASSESSED,
      })
    );
  } else if (active !== null && digital !== null && digital < active) {
    found.push(
      opportunity({
        platform: 'etsy',
        issue: `${active - digital} of ${active} active listing(s) in ${name} are not reported as digital.`,
        evidence: [`Etsy returned listing_active_count: ${active} and digital_listing_count: ${digital} for shop ${shop.shop_id}.`],
        proposedAction:
          'Confirm whether those listings are meant to be physical. Nothing about their content is assessed here - inspect the listings themselves for that.',
        requiresApproval: false,
        notAssessed: ETSY_SHOP_NOT_ASSESSED,
        // Two counts establish the difference and nothing about why - a weaker claim than a
        // directly observed field, and graded as such rather than asserted at 'high'.
        confidence: 'medium',
      })
    );
  }
  return found;
}

// --- Evidence limits a step declared about itself -------------------------------------------

// A limitation the specialist recorded is relayed as a limit on the evidence, never reasoned
// past. This is what makes "a capped read, not necessarily every order" visible to the owner
// instead of the count reading as the whole truth.
function evidenceLimits(step) {
  const outputs = isPlainObject(step) && isPlainObject(step.outputs) ? step.outputs : {};
  const result = isPlainObject(outputs.result) ? outputs.result : {};
  const limitations = Array.isArray(result.limitations) ? result.limitations.filter((entry) => str(entry)) : [];
  if (limitations.length === 0) return null;
  const inputs = isPlainObject(step.inputs) ? step.inputs : {};
  return {
    capability: str(inputs.capability_id),
    tool: str(inputs.tool_id),
    limitations: limitations.map((entry) => entry.trim()),
  };
}

// plan: the Chief's routing.plan. Returns { opportunities, evidence_limits, considered } - and
// an empty opportunities array is a legitimate, honest outcome, not a reason to reach for
// something weaker.
function deriveStoreDataOpportunities(plan) {
  const steps = (Array.isArray(plan) ? plan : []).filter(isPlainObject);
  const opportunities = [];
  const limits = [];
  let sourcesRead = 0;

  for (const step of steps) {
    if (step.completion_state !== 'complete') continue;
    const inputs = isPlainObject(step.inputs) ? step.inputs : {};
    const outputs = isPlainObject(step.outputs) ? step.outputs : {};
    const result = outputs.result;

    if (inputs.tool_id === 'product_data_retrieval' && Array.isArray(result)) {
      sourcesRead += 1;
      opportunities.push(...shopifyProductOpportunities(result));
    } else if (inputs.tool_id === 'etsy_shop_data_retrieval' && isPlainObject(result)) {
      sourcesRead += 1;
      opportunities.push(...etsyShopOpportunities(result));
    }

    const limit = evidenceLimits(step);
    if (limit) limits.push(limit);
  }

  // Most-evidenced first. Stable beyond that: the plan's own order decides ties, so the
  // ordering is reproducible and nothing is scored.
  opportunities.sort((a, b) => b.evidence.length - a.evidence.length);

  return {
    opportunities,
    evidence_limits: limits,
    considered: {
      store_reads: sourcesRead,
      platforms: [...new Set(opportunities.map((entry) => entry.platform))].sort(),
      note:
        sourcesRead === 0
          ? 'No store read in this run carried records these rules can assess, so no opportunity was derived.'
          : null,
    },
  };
}

module.exports = {
  SHOPIFY_PRODUCT_NOT_ASSESSED,
  ETSY_SHOP_NOT_ASSESSED,
  deriveStoreDataOpportunities,
};
