'use strict';

// The Conversion Optimization Checker (CRO audit). Evaluates 8 dimensions of a
// store's real, caller-supplied evidence - product pages, landing pages, offers, CTA,
// trust signals, checkout friction, mobile experience, pricing presentation - and
// reports honestly how well each one checks out. Never invents a judgment: every
// finding is a concrete, mechanical fact about the actual supplied evidence (a count,
// a boolean presence check, a numeric threshold comparison) - never a subjective
// opinion about design quality, persuasiveness, or an actual conversion-rate
// prediction. Where a dimension has nothing to check (e.g. no checkout-friction
// evidence was supplied), that is reported honestly as 'empty', with a finding
// explaining why, not silently skipped or guessed.
//
// This module never fetches a live page, screenshot, or theme file - there is no tool
// in this project that can (see integrations/adapters/shopifyClient.js's own scope:
// read-only product/order/customer/inventory data only, no page/theme/checkout
// rendering). Every dimension's evidence is supplied by the caller as plain structured
// facts (e.g. { stepsToCheckout: 5, guestCheckoutAvailable: false }) - the same
// deterministic, evidence-only philosophy as agent/core/seoQualityChecker.js and
// agent/core/listingQualityChecker.js.
//
// Standalone deliverable, not wired into tools/toolRegistry.js or
// agent/core/orchestratorExecutionContract.js - the same deliberate scope choice
// agent/core/seoQualityChecker.js, agent/core/listingQualityChecker.js,
// agent/core/growthOpportunityEngine.js, agent/core/offerRecommendationEngine.js, and
// agent/core/productOpportunityScoringEngine.js already made (a checker that evaluates
// caller-supplied structured evidence, directly callable, not part of the
// 7-capability dispatcher). A future, explicitly-scoped prompt can wire it in if
// wanted.
//
// "Do not automatically modify production pages": this module has no write/execute/
// publish code path anywhere - it only reads caller-supplied evidence and composes a
// structured audit record. Applying any recommendation to a real page is a separate,
// human-approved action (see approvals/README.md) - the same standing rule every other
// checker/recommendation module in this project already states.
//
// quality_score is a mechanical checklist-coverage measurement (how many of the 8
// dimensions' structural checks passed) - never a claim about actual conversion-rate
// impact. See agent/core/conversionOptimizationCheckModel.js's own header for how this
// differs from agent/core/analyticsModel.js's `conversion` snapshot category (numeric
// metrics) and agent/core/marketingAgent.js's `conversion_opportunities` capability
// (upsell/cross-sell/retention growth records) - three different concerns that happen
// to share the word "conversion".
//
// PRIORITIZATION: prioritized_recommendations tags every flagged issue with a fixed,
// documented SEVERITY_LEVELS tier (critical/high/medium/low), assigned per specific
// check below from widely-documented e-commerce CRO conventions (e.g. a missing guest
// checkout option is tiered 'critical' - a commonly cited top cause of cart
// abandonment - while a missing compare-at price is tiered 'low'). This is the same
// kind of labeled, conventional heuristic agent/core/seoQualityChecker.js's title/meta
// length guidelines already use - never a per-instance invented business-impact
// estimate (no dollar amount, no percentage-lift claim). Sorted descending by severity
// tier; ties are broken by dimension order (CONVERSION_OPTIMIZATION_DIMENSIONS order),
// then check order within the dimension - a stable sort, documented here rather than
// left implicit (same tie-break discipline as agent/core/growthOpportunityEngine.js).

const {
  CONVERSION_OPTIMIZATION_DIMENSIONS,
  SEVERITY_LEVELS,
  createEmptyConversionOptimizationCheck,
  validateConversionOptimizationCheckShape,
} = require('./conversionOptimizationCheckModel');

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

// Conventional, widely-documented e-commerce CRO guidelines - explicit, labeled
// thresholds, never presented as a guarantee of conversion-rate impact for any
// specific business (the same honesty agent/core/seoQualityChecker.js's title/meta
// length guidelines already establish).
const PRODUCT_PAGE_MIN_IMAGES = 3;
const LANDING_PAGE_MAX_LOAD_TIME_SECONDS = 3;
const CTA_MAX_BUTTON_COUNT = 3;
const CHECKOUT_MAX_STEPS = 4;
const CHECKOUT_MIN_PAYMENT_METHODS = 2;
const CHECKOUT_MAX_FORM_FIELDS = 8;
const MOBILE_PAGE_SPEED_MIN_SCORE = 50;

// Shared status rule: once real evidence exists for a dimension, it is never
// downgraded back to 'empty' just because every check against it failed - that would
// conflate "nothing to check" with "checked and needs work" (same rule
// agent/core/seoQualityChecker.js's deriveNonEmptyCheckStatus already establishes).
function deriveNonEmptyCheckStatus(passedCount, applicableCount) {
  return passedCount === applicableCount ? 'success' : 'partial';
}

// Runs one dimension's checklist against caller-supplied evidence. Each check
// descriptor: { applicable? (evidence) => bool, test (evidence) => bool, passMessage,
// failMessage, recommendation, severity }. `applicable` lets a check be skipped
// (neither passed nor failed) when its precondition isn't met (e.g. offer-specific
// checks only apply when an offer actually exists) without being counted as a
// failure. `severity` is a fixed SEVERITY_LEVELS member, never computed per instance.
function runDimensionChecklist(evidence, checks) {
  const findings = [];
  const recommendations = [];
  let passed = 0;
  let applicable = 0;

  for (const check of checks) {
    if (check.applicable && !check.applicable(evidence)) continue;
    applicable += 1;
    if (check.test(evidence)) {
      passed += 1;
      findings.push(check.passMessage(evidence));
    } else {
      findings.push(check.failMessage(evidence));
      recommendations.push({ text: check.recommendation(evidence), severity: check.severity });
    }
  }

  return { passed, applicable, findings, recommendations };
}

function boolCheck({ field, label, severity, recommendation }) {
  return {
    test: (e) => Boolean(e[field]),
    passMessage: () => `${label} is present.`,
    failMessage: () => `${label} is missing.`,
    recommendation: () => recommendation,
    severity,
  };
}

// ---------------------------------------------------------------------------------
// One check function per dimension. Each returns { status, findings, recommendations }
// - status is always 'empty' (no evidence supplied), 'partial' (some checks passed),
// or 'success' (every applicable check passed).
// ---------------------------------------------------------------------------------

function checkProductPages(evidence) {
  if (!evidence) {
    return {
      status: 'empty',
      findings: ['No product page evidence was supplied to audit.'],
      recommendations: [],
    };
  }

  const checks = [
    {
      test: (e) => typeof e.imagesCount === 'number' && e.imagesCount >= PRODUCT_PAGE_MIN_IMAGES,
      passMessage: (e) => `Product page has ${e.imagesCount} image(s), meeting the ${PRODUCT_PAGE_MIN_IMAGES}-image conventional guideline.`,
      failMessage: (e) => `Product page has ${e.imagesCount || 0} image(s) (conventional guideline: at least ${PRODUCT_PAGE_MIN_IMAGES}).`,
      recommendation: () => `Add more product images - aim for at least ${PRODUCT_PAGE_MIN_IMAGES}.`,
      severity: 'medium',
    },
    boolCheck({ field: 'hasDescription', label: 'A product description', severity: 'high', recommendation: 'Add a product description.' }),
    boolCheck({ field: 'hasPriceDisplayed', label: 'A clearly displayed price', severity: 'critical', recommendation: 'Display the price clearly on the product page.' }),
    boolCheck({ field: 'hasAvailabilityStatus', label: 'A stock/availability status', severity: 'medium', recommendation: 'Show stock/availability status on the product page.' }),
    boolCheck({ field: 'hasCustomerReviews', label: 'Customer reviews', severity: 'medium', recommendation: 'Add customer reviews or ratings to the product page.' }),
  ];

  const { passed, applicable, findings, recommendations } = runDimensionChecklist(evidence, checks);
  return { status: deriveNonEmptyCheckStatus(passed, applicable), findings, recommendations };
}

function checkLandingPages(evidence) {
  if (!evidence) {
    return {
      status: 'empty',
      findings: ['No landing page evidence was supplied to audit.'],
      recommendations: [],
    };
  }

  const checks = [
    boolCheck({ field: 'hasClearHeadline', label: 'A clear headline', severity: 'high', recommendation: 'Add a clear, benefit-focused headline.' }),
    boolCheck({ field: 'hasValueProposition', label: 'A value proposition', severity: 'high', recommendation: 'State a clear value proposition near the top of the page.' }),
    boolCheck({ field: 'hasHeroCta', label: 'A hero call-to-action', severity: 'critical', recommendation: 'Add a clear call-to-action in the hero section.' }),
    {
      test: (e) => typeof e.loadTimeSeconds === 'number' && e.loadTimeSeconds <= LANDING_PAGE_MAX_LOAD_TIME_SECONDS,
      passMessage: (e) => `Page load time (${e.loadTimeSeconds}s) is within the conventional ${LANDING_PAGE_MAX_LOAD_TIME_SECONDS}s guideline.`,
      failMessage: (e) => `Page load time is ${e.loadTimeSeconds ?? 'unknown'}s (conventional guideline: ${LANDING_PAGE_MAX_LOAD_TIME_SECONDS}s or less).`,
      recommendation: () => `Reduce page load time to ${LANDING_PAGE_MAX_LOAD_TIME_SECONDS}s or less - slow load times are a well-documented cause of bounce/abandonment.`,
      severity: 'critical',
    },
    boolCheck({ field: 'hasSocialProof', label: 'Social proof (testimonials, review counts, etc.)', severity: 'medium', recommendation: 'Add social proof (testimonials, review counts, trust indicators).' }),
  ];

  const { passed, applicable, findings, recommendations } = runDimensionChecklist(evidence, checks);
  return { status: deriveNonEmptyCheckStatus(passed, applicable), findings, recommendations };
}

// Offer-specific checks only apply when an active offer actually exists - "no active
// offer" is not itself a gap to fix (a store isn't required to always run a
// promotion), so it is reported as 'empty', not a failure.
function checkOffers(evidence) {
  if (!evidence || !evidence.hasActiveOffer) {
    return {
      status: 'empty',
      findings: ['No active offer was supplied to audit.'],
      recommendations: [],
    };
  }

  const checks = [
    boolCheck({ field: 'offerTermsClear', label: 'Clear offer terms', severity: 'high', recommendation: 'Clarify the offer terms (what qualifies, any restrictions).' }),
    boolCheck({ field: 'offerExpiryShown', label: 'A shown offer expiry', severity: 'medium', recommendation: 'Show the offer expiry/end date.' }),
    boolCheck({ field: 'discountVisibleBeforeCheckout', label: 'A discount visible before checkout', severity: 'high', recommendation: 'Make the discount visible before the customer reaches checkout.' }),
  ];

  const { passed, applicable, findings, recommendations } = runDimensionChecklist(evidence, checks);
  return { status: deriveNonEmptyCheckStatus(passed, applicable), findings, recommendations };
}

function checkCta(evidence) {
  if (!evidence) {
    return {
      status: 'empty',
      findings: ['No CTA evidence was supplied to audit.'],
      recommendations: [],
    };
  }

  const checks = [
    {
      test: (e) => typeof e.ctaText === 'string' && e.ctaText.trim() !== '',
      passMessage: (e) => `CTA text is present ("${e.ctaText}").`,
      failMessage: () => 'CTA text is missing.',
      recommendation: () => 'Add clear CTA text (e.g. "Add to Cart", "Buy Now").',
      severity: 'critical',
    },
    boolCheck({ field: 'ctaAboveFold', label: 'A CTA above the fold', severity: 'high', recommendation: 'Place a CTA above the fold so it is visible without scrolling.' }),
    {
      test: (e) => typeof e.ctaButtonCount === 'number' && e.ctaButtonCount >= 1,
      passMessage: (e) => `${e.ctaButtonCount} CTA button(s) present.`,
      failMessage: () => 'No CTA button is present.',
      recommendation: () => 'Add at least one clear CTA button.',
      severity: 'critical',
    },
    {
      applicable: (e) => typeof e.ctaButtonCount === 'number' && e.ctaButtonCount >= 1,
      test: (e) => e.ctaButtonCount <= CTA_MAX_BUTTON_COUNT,
      passMessage: (e) => `CTA button count (${e.ctaButtonCount}) stays within the conventional ${CTA_MAX_BUTTON_COUNT}-button guideline.`,
      failMessage: (e) => `${e.ctaButtonCount} CTA buttons are present (conventional guideline: at most ${CTA_MAX_BUTTON_COUNT}) - competing CTAs can dilute conversion.`,
      recommendation: () => `Reduce the number of competing CTA buttons to at most ${CTA_MAX_BUTTON_COUNT}.`,
      severity: 'low',
    },
    boolCheck({ field: 'ctaContrastSufficient', label: 'Sufficient CTA color contrast', severity: 'high', recommendation: 'Increase the CTA button\'s color contrast so it stands out visually.' }),
  ];

  const { passed, applicable, findings, recommendations } = runDimensionChecklist(evidence, checks);
  return { status: deriveNonEmptyCheckStatus(passed, applicable), findings, recommendations };
}

function checkTrustSignals(evidence) {
  if (!evidence) {
    return {
      status: 'empty',
      findings: ['No trust signal evidence was supplied to audit.'],
      recommendations: [],
    };
  }

  const checks = [
    boolCheck({ field: 'hasSecurityBadges', label: 'Security/payment trust badges', severity: 'high', recommendation: 'Add security/payment trust badges (e.g. SSL, accepted payment logos).' }),
    boolCheck({ field: 'hasReturnPolicyVisible', label: 'A visible return policy', severity: 'high', recommendation: 'Make the return policy visible on the page.' }),
    boolCheck({ field: 'hasMoneyBackGuarantee', label: 'A money-back guarantee', severity: 'medium', recommendation: 'Consider offering and displaying a money-back guarantee.' }),
    boolCheck({ field: 'hasCustomerReviews', label: 'Customer reviews', severity: 'medium', recommendation: 'Display customer reviews or ratings as social proof.' }),
    boolCheck({ field: 'hasContactInfoVisible', label: 'Visible contact information', severity: 'medium', recommendation: 'Make contact information (support email/phone) visible.' }),
  ];

  const { passed, applicable, findings, recommendations } = runDimensionChecklist(evidence, checks);
  return { status: deriveNonEmptyCheckStatus(passed, applicable), findings, recommendations };
}

function checkCheckoutFriction(evidence) {
  if (!evidence) {
    return {
      status: 'empty',
      findings: ['No checkout evidence was supplied to audit.'],
      recommendations: [],
    };
  }

  const checks = [
    {
      test: (e) => typeof e.stepsToCheckout === 'number' && e.stepsToCheckout <= CHECKOUT_MAX_STEPS,
      passMessage: (e) => `Checkout takes ${e.stepsToCheckout} step(s), within the conventional ${CHECKOUT_MAX_STEPS}-step guideline.`,
      failMessage: (e) => `Checkout takes ${e.stepsToCheckout ?? 'an unknown number of'} step(s) (conventional guideline: at most ${CHECKOUT_MAX_STEPS}).`,
      recommendation: () => `Reduce checkout to at most ${CHECKOUT_MAX_STEPS} steps - more steps are a well-documented cause of cart abandonment.`,
      severity: 'critical',
    },
    boolCheck({ field: 'guestCheckoutAvailable', label: 'Guest checkout', severity: 'critical', recommendation: 'Offer guest checkout - mandatory account creation is a commonly cited top cause of cart abandonment.' }),
    {
      test: (e) => !e.accountCreationRequired,
      passMessage: () => 'Account creation is not required to check out.',
      failMessage: () => 'Account creation is required to check out.',
      recommendation: () => 'Remove the requirement to create an account before checking out.',
      severity: 'critical',
    },
    {
      test: (e) => typeof e.paymentMethodsCount === 'number' && e.paymentMethodsCount >= CHECKOUT_MIN_PAYMENT_METHODS,
      passMessage: (e) => `${e.paymentMethodsCount} payment method(s) are offered, meeting the ${CHECKOUT_MIN_PAYMENT_METHODS}-method conventional guideline.`,
      failMessage: (e) => `${e.paymentMethodsCount || 0} payment method(s) are offered (conventional guideline: at least ${CHECKOUT_MIN_PAYMENT_METHODS}).`,
      recommendation: () => `Offer at least ${CHECKOUT_MIN_PAYMENT_METHODS} payment methods.`,
      severity: 'medium',
    },
    {
      test: (e) => typeof e.formFieldsCount === 'number' && e.formFieldsCount <= CHECKOUT_MAX_FORM_FIELDS,
      passMessage: (e) => `Checkout form has ${e.formFieldsCount} field(s), within the conventional ${CHECKOUT_MAX_FORM_FIELDS}-field guideline.`,
      failMessage: (e) => `Checkout form has ${e.formFieldsCount ?? 'an unknown number of'} field(s) (conventional guideline: at most ${CHECKOUT_MAX_FORM_FIELDS}).`,
      recommendation: () => `Reduce the checkout form to at most ${CHECKOUT_MAX_FORM_FIELDS} fields.`,
      severity: 'medium',
    },
  ];

  const { passed, applicable, findings, recommendations } = runDimensionChecklist(evidence, checks);
  return { status: deriveNonEmptyCheckStatus(passed, applicable), findings, recommendations };
}

function checkMobileExperience(evidence) {
  if (!evidence) {
    return {
      status: 'empty',
      findings: ['No mobile experience evidence was supplied to audit.'],
      recommendations: [],
    };
  }

  const checks = [
    boolCheck({ field: 'mobileResponsive', label: 'A mobile-responsive layout', severity: 'critical', recommendation: 'Make the page layout mobile-responsive - a majority of e-commerce traffic is mobile.' }),
    {
      test: (e) => typeof e.mobilePageSpeedScore === 'number' && e.mobilePageSpeedScore >= MOBILE_PAGE_SPEED_MIN_SCORE,
      passMessage: (e) => `Mobile page speed score (${e.mobilePageSpeedScore}) meets the conventional ${MOBILE_PAGE_SPEED_MIN_SCORE}+ guideline.`,
      failMessage: (e) => `Mobile page speed score is ${e.mobilePageSpeedScore ?? 'unknown'} (conventional guideline: ${MOBILE_PAGE_SPEED_MIN_SCORE}+).`,
      recommendation: () => `Improve mobile page speed to at least ${MOBILE_PAGE_SPEED_MIN_SCORE}.`,
      severity: 'high',
    },
    boolCheck({ field: 'tapTargetsAdequate', label: 'Adequately sized tap targets', severity: 'medium', recommendation: 'Increase tap target sizes for mobile usability.' }),
    boolCheck({ field: 'mobileCheckoutOptimized', label: 'A mobile-optimized checkout', severity: 'high', recommendation: 'Optimize the checkout flow specifically for mobile.' }),
  ];

  const { passed, applicable, findings, recommendations } = runDimensionChecklist(evidence, checks);
  return { status: deriveNonEmptyCheckStatus(passed, applicable), findings, recommendations };
}

function checkPricingPresentation(evidence) {
  if (!evidence) {
    return {
      status: 'empty',
      findings: ['No pricing presentation evidence was supplied to audit.'],
      recommendations: [],
    };
  }

  const checks = [
    boolCheck({ field: 'priceClearlyDisplayed', label: 'A clearly displayed price', severity: 'critical', recommendation: 'Display the price clearly and prominently.' }),
    boolCheck({ field: 'compareAtPriceShown', label: 'A compare-at (original) price', severity: 'low', recommendation: 'Consider showing a compare-at price to frame the discount.' }),
    boolCheck({ field: 'shippingCostShownBeforeCheckout', label: 'Shipping cost shown before checkout', severity: 'critical', recommendation: 'Show shipping cost before checkout - unexpected shipping costs are a commonly cited top cause of cart abandonment.' }),
    boolCheck({ field: 'currencyClear', label: 'A clearly indicated currency', severity: 'medium', recommendation: 'Clearly indicate the currency prices are shown in.' }),
    boolCheck({ field: 'allCostsShownBeforeCheckout', label: 'All costs (taxes/fees) shown before checkout', severity: 'critical', recommendation: 'Disclose all costs (taxes, fees) before checkout - hidden fees are a commonly cited top cause of cart abandonment.' }),
  ];

  const { passed, applicable, findings, recommendations } = runDimensionChecklist(evidence, checks);
  return { status: deriveNonEmptyCheckStatus(passed, applicable), findings, recommendations };
}

const DIMENSION_CHECKS = {
  product_pages: checkProductPages,
  landing_pages: checkLandingPages,
  offers: checkOffers,
  cta: checkCta,
  trust_signals: checkTrustSignals,
  checkout_friction: checkCheckoutFriction,
  mobile_experience: checkMobileExperience,
  pricing_presentation: checkPricingPresentation,
};

const DIMENSION_LABELS = {
  product_pages: 'Product pages',
  landing_pages: 'Landing pages',
  offers: 'Offers',
  cta: 'CTA',
  trust_signals: 'Trust signals',
  checkout_friction: 'Checkout friction',
  mobile_experience: 'Mobile experience',
  pricing_presentation: 'Pricing presentation',
};

const DIMENSION_EVIDENCE_PARAMS = {
  product_pages: 'productPages',
  landing_pages: 'landingPages',
  offers: 'offers',
  cta: 'cta',
  trust_signals: 'trustSignals',
  checkout_friction: 'checkoutFriction',
  mobile_experience: 'mobileExperience',
  pricing_presentation: 'pricingPresentation',
};

const SEVERITY_RANK = SEVERITY_LEVELS.reduce((rank, level, index) => {
  rank[level] = index;
  return rank;
}, {});

function buildDimensionGapReason(dimensionId, status) {
  const label = DIMENSION_LABELS[dimensionId];
  if (status === 'empty') {
    return `${label} has no evidence supplied, or every applicable check failed.`;
  }
  return `${label} has at least one unresolved check.`;
}

// ---------------------------------------------------------------------------------
// Combined entry point. Every dimension parameter is optional and caller-supplied -
// this checker never fetches a live page and never invents evidence.
// ---------------------------------------------------------------------------------

function checkConversionOptimization({
  subjectReference = '',
  productPages,
  landingPages,
  offers,
  cta,
  trustSignals,
  checkoutFriction,
  mobileExperience,
  pricingPresentation,
  researchDate,
} = {}) {
  const evidenceByDimension = {
    product_pages: productPages,
    landing_pages: landingPages,
    offers,
    cta,
    trust_signals: trustSignals,
    checkout_friction: checkoutFriction,
    mobile_experience: mobileExperience,
    pricing_presentation: pricingPresentation,
  };

  const dimensionStatus = {};
  const findings = [];
  const recommendations = [];
  const prioritizedRecommendations = [];
  const dimensionGaps = [];
  const specializedRecords = {};

  for (const dimensionId of CONVERSION_OPTIMIZATION_DIMENSIONS) {
    const evidence = evidenceByDimension[dimensionId];
    specializedRecords[dimensionId] = evidence || null;

    const check = DIMENSION_CHECKS[dimensionId](evidence);
    dimensionStatus[dimensionId] = check.status;
    const label = DIMENSION_LABELS[dimensionId];

    findings.push(...check.findings.map((finding) => `[${label}] ${finding}`));
    for (const recommendation of check.recommendations) {
      recommendations.push(`[${label}] ${recommendation.text}`);
      prioritizedRecommendations.push({
        dimension: dimensionId,
        recommendation: recommendation.text,
        severity: recommendation.severity,
      });
    }

    if (check.status !== 'success') {
      dimensionGaps.push({ dimension: dimensionId, reason: buildDimensionGapReason(dimensionId, check.status) });
    }
  }

  prioritizedRecommendations.sort((a, b) => {
    const severityDelta = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (severityDelta !== 0) return severityDelta;
    return CONVERSION_OPTIMIZATION_DIMENSIONS.indexOf(a.dimension) - CONVERSION_OPTIMIZATION_DIMENSIONS.indexOf(b.dimension);
  });

  const statuses = Object.values(dimensionStatus);
  const dimensionsTotal = CONVERSION_OPTIMIZATION_DIMENSIONS.length;
  const dimensionsSuccess = statuses.filter((status) => status === 'success').length;
  const dimensionsPartial = statuses.filter((status) => status === 'partial').length;
  const dimensionsEmpty = statuses.filter((status) => status === 'empty').length;
  let scoreStatus = 'empty';
  if (dimensionsSuccess === dimensionsTotal) scoreStatus = 'success';
  else if (dimensionsSuccess > 0) scoreStatus = 'partial';

  const result = createEmptyConversionOptimizationCheck(subjectReference);
  result.research_date = researchDate || todayIsoDate();
  result.dimension_status = dimensionStatus;
  result.findings = findings;
  result.recommendations = recommendations;
  result.prioritized_recommendations = prioritizedRecommendations;
  result.dimension_gaps = dimensionGaps;
  result.quality_score = {
    dimensions_total: dimensionsTotal,
    dimensions_success: dimensionsSuccess,
    dimensions_partial: dimensionsPartial,
    dimensions_empty: dimensionsEmpty,
    percentage: Math.round((dimensionsSuccess / dimensionsTotal) * 100),
    status: scoreStatus,
  };
  result.specialized_records = specializedRecords;

  const validation = validateConversionOptimizationCheckShape(result);
  if (!validation.valid) {
    throw new Error(`Composed Conversion Optimization check failed validation: ${validation.errors.join('; ')}`);
  }
  return result;
}

module.exports = {
  checkConversionOptimization,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - Conversion Optimization Checker (deterministic, mechanical checks only):\n');

  const result = checkConversionOptimization({
    subjectReference: '(Example insulated jacket product page)',
    productPages: {
      imagesCount: 2,
      hasDescription: true,
      hasPriceDisplayed: true,
      hasAvailabilityStatus: false,
      hasCustomerReviews: true,
    },
    cta: {
      ctaText: 'Add to Cart',
      ctaAboveFold: true,
      ctaButtonCount: 1,
      ctaContrastSufficient: false,
    },
    trustSignals: {
      hasSecurityBadges: false,
      hasReturnPolicyVisible: true,
      hasMoneyBackGuarantee: false,
      hasCustomerReviews: true,
      hasContactInfoVisible: true,
    },
    checkoutFriction: {
      stepsToCheckout: 5,
      guestCheckoutAvailable: false,
      accountCreationRequired: true,
      paymentMethodsCount: 3,
      formFieldsCount: 10,
    },
    mobileExperience: {
      mobileResponsive: true,
      mobilePageSpeedScore: 42,
      tapTargetsAdequate: true,
      mobileCheckoutOptimized: false,
    },
    pricingPresentation: {
      priceClearlyDisplayed: true,
      compareAtPriceShown: false,
      shippingCostShownBeforeCheckout: false,
      currencyClear: true,
      allCostsShownBeforeCheckout: false,
    },
    // landingPages and offers deliberately left unsupplied - demonstrates the honest
    // 'empty' path when no evidence exists for a dimension.
  });

  console.log(JSON.stringify(result, null, 2));

  console.log('\nNo finding above is real - every value is a caller-supplied placeholder for demonstration.');
  console.log('quality_score is a mechanical checklist-coverage measurement only, never a conversion-rate prediction.');
  console.log('This checker never fetches or modifies a real page - every recommendation requires a separate, human-approved action to apply.');
}
