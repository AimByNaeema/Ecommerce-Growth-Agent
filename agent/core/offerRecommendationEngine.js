'use strict';

// The Offer Recommendation Engine. For one product, mechanically derives offer
// recommendations across 7 dimensions - bundles, discounts, upsells, cross-sells,
// incentives, value propositions, objection handling - from caller-supplied product
// and business data only. Never invents a product, a discount depth, an incentive, a
// value proposition, or an objection response: every recommendation is either a
// direct, evidence-labeled relay of a real supplied entry, or (discounts only) a plain
// arithmetic computation over caller-supplied pricing and margin constraints. Where a
// dimension has nothing to work with, that is reported honestly as 'empty', with a
// finding explaining why, not silently skipped or guessed - the same structural-audit
// philosophy as agent/core/productOpportunityScoringEngine.js and
// agent/core/listingQualityChecker.js.
//
// Standalone deliverable, not yet wired into tools/toolRegistry.js or
// agent/core/orchestratorExecutionContract.js - the same deliberate scope choice
// agent/core/productOpportunityScoringEngine.js, agent/core/productRecommendationEngine.js,
// agent/core/seoQualityChecker.js, and agent/core/listingQualityChecker.js already made
// (a recommendation/scoring engine that composes existing structured input, directly
// callable, not part of a 7-capability dispatcher). A future, explicitly-scoped prompt
// can wire it in if wanted.
//
// "Do not create unsupported guarantees or claims" is enforced structurally, not just
// documented: every value proposition and objection response is scanned for
// absolute/superlative claim phrases (reusing
// agent/core/listingQualityChecker.js's own CLAIM_TRIGGER_PHRASES/containsText, never
// redefined here) and, when no evidence was supplied for that entry, the phrase is
// surfaced in the result's unsupported_claims_flagged field rather than silently
// relayed as if it were a verified fact.
//
// bundle/upsell/cross_sell are distinguished purely by the caller-asserted
// `relationship` on each relatedProducts entry (agent/core/offerRecommendationModel.js's
// RELATIONSHIP_TYPES) - never inferred from price or category. discount is the one
// dimension with real arithmetic: margin = (price - cost) / price, and the recommended
// discount depth is capped so margin never drops below a caller-supplied
// minMarginPercent - a plain, auditable calculation, never a guessed promotional idea.

const {
  OFFER_RECOMMENDATION_TYPES,
  RELATIONSHIP_TYPES,
  createEmptyOfferRecommendation,
  validateOfferRecommendationShape,
} = require('./offerRecommendationModel');
const { CLAIM_TRIGGER_PHRASES, containsText } = require('./listingQualityChecker');

function requireNonEmptyString(value, fieldName, fnName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fnName} requires a non-empty \`${fieldName}\` string.`);
  }
}

function requireObjectEntry(entry, fieldName, fnName) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${fnName} requires each \`${fieldName}\` entry to be an object.`);
  }
}

function normalizeArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function evidencePresent(entry) {
  return entry.evidence.length > 0;
}

// Shared status rule: 'empty' reserved strictly for "nothing was supplied to check" -
// once real entries exist, a dimension is never degraded back to 'empty' just because
// some entries lack evidence. Matches
// agent/core/listingQualityChecker.js's/agent/core/seoQualityChecker.js's identical
// rule.
function deriveNonEmptyCheckStatus(evidencedCount, totalCount) {
  return evidencedCount === totalCount ? 'success' : 'partial';
}

// ---------------------------------------------------------------------------------
// Input normalization - validates and normalizes each caller-supplied entry array.
// Throws on a structurally invalid entry (never silently drops or guesses one); never
// invents an entry that wasn't supplied.
// ---------------------------------------------------------------------------------

function normalizeRelatedProducts(relatedProducts, fnName) {
  return relatedProducts.map((entry, index) => {
    requireObjectEntry(entry, 'relatedProducts', fnName);
    requireNonEmptyString(entry.productReference, `relatedProducts[${index}].productReference`, fnName);
    if (!RELATIONSHIP_TYPES.includes(entry.relationship)) {
      throw new Error(
        `${fnName} requires relatedProducts[${index}].relationship to be one of: ${RELATIONSHIP_TYPES.join(', ')}`
      );
    }
    return {
      productReference: entry.productReference,
      relationship: entry.relationship,
      evidence: normalizeArray(entry.evidence),
    };
  });
}

function normalizeIncentiveOptions(incentiveOptions, fnName) {
  return incentiveOptions.map((entry, index) => {
    requireObjectEntry(entry, 'incentiveOptions', fnName);
    requireNonEmptyString(entry.incentive, `incentiveOptions[${index}].incentive`, fnName);
    return { incentive: entry.incentive, evidence: normalizeArray(entry.evidence) };
  });
}

function normalizeValuePropositions(valuePropositions, fnName) {
  return valuePropositions.map((entry, index) => {
    requireObjectEntry(entry, 'valuePropositions', fnName);
    requireNonEmptyString(entry.statement, `valuePropositions[${index}].statement`, fnName);
    return { statement: entry.statement, evidence: normalizeArray(entry.evidence) };
  });
}

function normalizeObjections(objections, fnName) {
  return objections.map((entry, index) => {
    requireObjectEntry(entry, 'objections', fnName);
    requireNonEmptyString(entry.objection, `objections[${index}].objection`, fnName);
    return {
      objection: entry.objection,
      response: entry.response || '',
      evidence: normalizeArray(entry.evidence),
    };
  });
}

// ---------------------------------------------------------------------------------
// One check function per dimension. Each returns
// { status, findings, recommendations, missingReason, unsupportedClaims } - status is
// 'empty' (nothing supplied), 'partial' (supplied but not fully evidenced/computable),
// or 'success' (supplied and fully evidenced/computable).
// ---------------------------------------------------------------------------------

function checkRelatedProductDimension(relatedProducts, allowedRelationships, label, buildAction) {
  const matches = relatedProducts.filter((entry) => allowedRelationships.includes(entry.relationship));
  if (matches.length === 0) {
    const reason = `No ${label} candidates were supplied.`;
    return { status: 'empty', findings: [reason], recommendations: [], missingReason: reason, unsupportedClaims: [] };
  }

  const evidenced = matches.filter(evidencePresent);
  const findings = [`${evidenced.length}/${matches.length} ${label} candidate(s) are evidence-backed.`];
  const recommendations = matches.map((entry) =>
    evidencePresent(entry)
      ? `${buildAction(entry.productReference)} (evidence: ${entry.evidence.join('; ')}).`
      : `${buildAction(entry.productReference)} - no supporting evidence supplied; verify before recommending.`
  );

  const status = deriveNonEmptyCheckStatus(evidenced.length, matches.length);
  const missingReason = status === 'partial' ? `Some ${label} candidates lack supporting evidence.` : null;
  return { status, findings, recommendations, missingReason, unsupportedClaims: [] };
}

function checkBundleDimension(relatedProducts, productReference) {
  return checkRelatedProductDimension(
    relatedProducts,
    ['bundle_candidate'],
    'bundle',
    (ref) => `Bundle "${productReference}" with "${ref}"`
  );
}

function checkUpsellDimension(relatedProducts, productReference) {
  return checkRelatedProductDimension(
    relatedProducts,
    ['higher_tier'],
    'upsell',
    (ref) => `Offer "${ref}" as a higher-tier upsell to "${productReference}"`
  );
}

function checkCrossSellDimension(relatedProducts, productReference) {
  return checkRelatedProductDimension(
    relatedProducts,
    ['complementary', 'accessory'],
    'cross-sell',
    (ref) => `Recommend "${ref}" as a cross-sell alongside "${productReference}"`
  );
}

// The one dimension with real arithmetic: margin = (price - cost) / price. The
// recommended discount depth is capped at whichever is smaller - the caller-supplied
// maxDiscountPercent, or the room left before margin drops below minMarginPercent -
// never a guessed promotional idea.
function checkDiscountDimension(pricing, discountConstraints) {
  const hasNumericPricing =
    pricing && typeof pricing.cost === 'number' && typeof pricing.price === 'number' && pricing.price > 0;
  const hasMinMargin = discountConstraints && typeof discountConstraints.minMarginPercent === 'number';

  if (!pricing && !discountConstraints) {
    const reason = 'No pricing or discount constraints were supplied.';
    return { status: 'empty', findings: [reason], recommendations: [], missingReason: reason, unsupportedClaims: [] };
  }

  if (!hasNumericPricing || !hasMinMargin) {
    const gaps = [];
    if (!hasNumericPricing) gaps.push('numeric pricing (cost and price)');
    if (!hasMinMargin) gaps.push('a minimum margin constraint (minMarginPercent)');
    const reason = `Discount cannot be computed: missing ${gaps.join(' and ')}.`;
    return { status: 'partial', findings: [reason], recommendations: [], missingReason: reason, unsupportedClaims: [] };
  }

  const marginPercent = ((pricing.price - pricing.cost) / pricing.price) * 100;
  const roomPercent = marginPercent - discountConstraints.minMarginPercent;
  const cap = typeof discountConstraints.maxDiscountPercent === 'number' ? discountConstraints.maxDiscountPercent : roomPercent;
  const recommendedDiscountPercent = Math.max(0, Math.min(cap, roomPercent));

  const findings = [
    `Current margin is ${marginPercent.toFixed(1)}%; minimum required margin is ${discountConstraints.minMarginPercent}%.`,
  ];
  const recommendations =
    recommendedDiscountPercent > 0
      ? [
          `A discount of up to ${recommendedDiscountPercent.toFixed(1)}% keeps margin at or above the required ${discountConstraints.minMarginPercent}% minimum.`,
        ]
      : [`No discount is currently supportable without breaching the minimum ${discountConstraints.minMarginPercent}% margin.`];

  return { status: 'success', findings, recommendations, missingReason: null, unsupportedClaims: [] };
}

function checkIncentiveDimension(incentiveOptions) {
  if (incentiveOptions.length === 0) {
    const reason = 'No incentive options were supplied.';
    return { status: 'empty', findings: [reason], recommendations: [], missingReason: reason, unsupportedClaims: [] };
  }

  const evidenced = incentiveOptions.filter(evidencePresent);
  const findings = [`${evidenced.length}/${incentiveOptions.length} incentive(s) are evidence-backed.`];
  const recommendations = incentiveOptions.map((entry) =>
    evidencePresent(entry)
      ? `Offer incentive: "${entry.incentive}" (evidence: ${entry.evidence.join('; ')}).`
      : `Incentive "${entry.incentive}" has no supporting evidence - verify it is currently configured/active before offering it.`
  );

  const status = deriveNonEmptyCheckStatus(evidenced.length, incentiveOptions.length);
  const missingReason = status === 'partial' ? 'Some incentive options lack supporting evidence.' : null;
  return { status, findings, recommendations, missingReason, unsupportedClaims: [] };
}

// A claim phrase in a statement is only flagged "unsupported" when no evidence was
// supplied for that whole statement - presence alone is never treated as false, since
// this engine has no independent source of truth (same honesty rule as
// agent/core/listingQualityChecker.js's checkUnsupportedClaims).
function scanForUnsupportedClaims(text, hasEvidence) {
  if (hasEvidence) return [];
  return CLAIM_TRIGGER_PHRASES.filter((phrase) => containsText(text, phrase));
}

function checkValuePropositionDimension(valuePropositions) {
  if (valuePropositions.length === 0) {
    const reason = 'No value propositions were supplied.';
    return { status: 'empty', findings: [reason], recommendations: [], missingReason: reason, unsupportedClaims: [] };
  }

  const unsupportedClaims = [];
  const recommendations = [];
  let evidencedCount = 0;

  for (const entry of valuePropositions) {
    const hasEvidence = evidencePresent(entry);
    if (hasEvidence) evidencedCount += 1;
    const flaggedPhrases = scanForUnsupportedClaims(entry.statement, hasEvidence);
    flaggedPhrases.forEach((phrase) =>
      unsupportedClaims.push(`"${phrase}" in value proposition "${entry.statement}" is not backed by supplied evidence.`)
    );
    recommendations.push(
      hasEvidence
        ? `Value proposition: "${entry.statement}" (evidence: ${entry.evidence.join('; ')}).`
        : `Value proposition: "${entry.statement}" - no supporting evidence supplied; verify before use.`
    );
  }

  const findings = [`${evidencedCount}/${valuePropositions.length} value proposition(s) are evidence-backed.`];
  const status = deriveNonEmptyCheckStatus(evidencedCount, valuePropositions.length);
  const missingReason = status === 'partial' ? 'Some value propositions lack supporting evidence.' : null;
  return { status, findings, recommendations, missingReason, unsupportedClaims };
}

function checkObjectionHandlingDimension(objections) {
  if (objections.length === 0) {
    const reason = 'No customer objections were supplied.';
    return { status: 'empty', findings: [reason], recommendations: [], missingReason: reason, unsupportedClaims: [] };
  }

  const unsupportedClaims = [];
  const recommendations = [];
  let evidencedCount = 0;

  for (const entry of objections) {
    if (!entry.response) {
      recommendations.push(`Objection "${entry.objection}" has no response yet - add one before using it in customer-facing content.`);
      continue;
    }
    const hasEvidence = evidencePresent(entry);
    if (hasEvidence) evidencedCount += 1;
    const flaggedPhrases = scanForUnsupportedClaims(entry.response, hasEvidence);
    flaggedPhrases.forEach((phrase) =>
      unsupportedClaims.push(`"${phrase}" in the response to objection "${entry.objection}" is not backed by supplied evidence.`)
    );
    recommendations.push(
      hasEvidence
        ? `Objection "${entry.objection}": ${entry.response} (evidence: ${entry.evidence.join('; ')}).`
        : `Objection "${entry.objection}": ${entry.response} - no supporting evidence supplied; verify before use.`
    );
  }

  const findings = [`${evidencedCount}/${objections.length} objection response(s) are evidence-backed.`];
  const status = deriveNonEmptyCheckStatus(evidencedCount, objections.length);
  const missingReason = status === 'partial' ? 'Some objection responses are missing or lack supporting evidence.' : null;
  return { status, findings, recommendations, missingReason, unsupportedClaims };
}

const DIMENSION_LABELS = {
  bundle: 'Bundle',
  discount: 'Discount',
  upsell: 'Upsell',
  cross_sell: 'Cross-sell',
  incentive: 'Incentive',
  value_proposition: 'Value proposition',
  objection_handling: 'Objection handling',
};

// Mechanical mapping from coverage_score.percentage onto CONFIDENCE_LEVELS - never a
// business judgment, matching agent/core/productRecommendationEngine.js's own
// deriveConfidence exactly.
function deriveConfidence(percentage) {
  if (percentage === 100) return 'high';
  if (percentage >= 50) return 'medium';
  if (percentage > 0) return 'low';
  return 'unassessed';
}

// ---------------------------------------------------------------------------------
// Combined entry point.
// ---------------------------------------------------------------------------------

function generateOfferRecommendations(params = {}) {
  const fnName = 'generateOfferRecommendations';
  const {
    productReference,
    market = '',
    pricing = null,
    discountConstraints = null,
    relatedProducts = [],
    incentiveOptions = [],
    valuePropositions = [],
    objections = [],
    researchDate,
  } = params;

  requireNonEmptyString(productReference, 'productReference', fnName);

  const normalizedRelatedProducts = normalizeRelatedProducts(relatedProducts, fnName);
  const normalizedIncentiveOptions = normalizeIncentiveOptions(incentiveOptions, fnName);
  const normalizedValuePropositions = normalizeValuePropositions(valuePropositions, fnName);
  const normalizedObjections = normalizeObjections(objections, fnName);

  const dimensionResults = {
    bundle: checkBundleDimension(normalizedRelatedProducts, productReference),
    discount: checkDiscountDimension(pricing, discountConstraints),
    upsell: checkUpsellDimension(normalizedRelatedProducts, productReference),
    cross_sell: checkCrossSellDimension(normalizedRelatedProducts, productReference),
    incentive: checkIncentiveDimension(normalizedIncentiveOptions),
    value_proposition: checkValuePropositionDimension(normalizedValuePropositions),
    objection_handling: checkObjectionHandlingDimension(normalizedObjections),
  };

  const dimensionStatus = {};
  const findings = [];
  const recommendations = [];
  const missingInformation = [];
  const unsupportedClaimsFlagged = [];

  for (const dimensionId of OFFER_RECOMMENDATION_TYPES) {
    const result = dimensionResults[dimensionId];
    dimensionStatus[dimensionId] = result.status;
    const label = DIMENSION_LABELS[dimensionId];
    findings.push(...result.findings.map((finding) => `[${label}] ${finding}`));
    recommendations.push(...result.recommendations.map((recommendation) => `[${label}] ${recommendation}`));
    unsupportedClaimsFlagged.push(...result.unsupportedClaims.map((claim) => `[${label}] ${claim}`));
    if (result.status !== 'success') {
      missingInformation.push({ dimension: dimensionId, reason: result.missingReason });
    }
  }

  const evidence = [
    ...normalizedRelatedProducts.flatMap((entry) => entry.evidence),
    ...normalizedIncentiveOptions.flatMap((entry) => entry.evidence),
    ...normalizedValuePropositions.flatMap((entry) => entry.evidence),
    ...normalizedObjections.flatMap((entry) => entry.evidence),
  ];

  const statuses = Object.values(dimensionStatus);
  const dimensionsTotal = OFFER_RECOMMENDATION_TYPES.length;
  const dimensionsSuccess = statuses.filter((status) => status === 'success').length;
  const dimensionsPartial = statuses.filter((status) => status === 'partial').length;
  const dimensionsEmpty = statuses.filter((status) => status === 'empty').length;
  let scoreStatus = 'empty';
  if (dimensionsSuccess === dimensionsTotal) scoreStatus = 'success';
  else if (dimensionsSuccess > 0) scoreStatus = 'partial';
  const percentage = Math.round((dimensionsSuccess / dimensionsTotal) * 100);

  const result = createEmptyOfferRecommendation(productReference);
  result.market = market;
  result.research_date = researchDate || todayIsoDate();
  result.dimension_status = dimensionStatus;
  result.findings = findings;
  result.recommendations = recommendations;
  result.missing_information = missingInformation;
  result.unsupported_claims_flagged = unsupportedClaimsFlagged;
  result.coverage_score = {
    dimensions_total: dimensionsTotal,
    dimensions_success: dimensionsSuccess,
    dimensions_partial: dimensionsPartial,
    dimensions_empty: dimensionsEmpty,
    percentage,
    status: scoreStatus,
  };
  result.confidence = deriveConfidence(percentage);
  result.evidence = evidence;
  result.specialized_records = {
    pricing,
    discount_constraints: discountConstraints,
    related_products: normalizedRelatedProducts,
    incentive_options: normalizedIncentiveOptions,
    value_propositions: normalizedValuePropositions,
    objections: normalizedObjections,
  };

  const validation = validateOfferRecommendationShape(result);
  if (!validation.valid) {
    throw new Error(`Composed Offer recommendation failed validation: ${validation.errors.join('; ')}`);
  }
  return result;
}

module.exports = {
  generateOfferRecommendations,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Offer Recommendation Engine (deterministic, mechanical only):\n');

  const result = generateOfferRecommendations({
    productReference: '(Example insulated jacket)',
    pricing: { currency: 'USD', cost: 35, price: 100 },
    discountConstraints: { minMarginPercent: 40, maxDiscountPercent: 25 },
    relatedProducts: [
      {
        productReference: '(Example wool hat)',
        relationship: 'bundle_candidate',
        evidence: ['(placeholder prior-purchase co-occurrence data)'],
      },
      {
        productReference: '(Example premium insulated jacket)',
        relationship: 'higher_tier',
        evidence: ['(placeholder catalog price comparison)'],
      },
      {
        productReference: '(Example wool gloves)',
        relationship: 'accessory',
        // deliberately no evidence - to show the honest "no supporting evidence" case.
      },
    ],
    incentiveOptions: [
      {
        incentive: 'Free shipping over $75 (caller-supplied placeholder, already configured in business.yaml)',
        evidence: ['(placeholder configuration/business.yaml reference)'],
      },
    ],
    valuePropositions: [
      {
        statement: 'Waterproof shell tested to 10,000mm hydrostatic head (caller-supplied placeholder).',
        evidence: ['(placeholder lab test report)'],
      },
      {
        statement: 'The best jacket you will ever own (caller-supplied placeholder, deliberately unevidenced).',
        // deliberately no evidence - to show an absolute claim phrase get flagged.
      },
    ],
    objections: [
      {
        objection: 'Is it too expensive?',
        response: 'It is priced at the premium tier for outdoor apparel; cost breakdown available on request (caller-supplied placeholder).',
        evidence: ['(placeholder pricing breakdown)'],
      },
    ],
  });

  console.log(JSON.stringify(result, null, 2));

  console.log('\nNo product, discount, incentive, value proposition, or objection response above is real - every value is a caller-supplied placeholder for demonstration.');
  console.log('This engine never purchases, publishes, or applies an offer automatically - acting on a recommendation is a separate, human-approved action via approvals/.');
}
