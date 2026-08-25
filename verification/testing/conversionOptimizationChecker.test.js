'use strict';

const assert = require('node:assert');
const { checkConversionOptimization } = require('../../agent/core/conversionOptimizationChecker');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(`  ${err.message}`);
    failed += 1;
  }
}

// A fully-populated, fully-passing evidence set - one honest example per dimension.
function fullEvidence() {
  return {
    subjectReference: '(Example product page)',
    productPages: {
      imagesCount: 3,
      hasDescription: true,
      hasPriceDisplayed: true,
      hasAvailabilityStatus: true,
      hasCustomerReviews: true,
    },
    landingPages: {
      hasClearHeadline: true,
      hasValueProposition: true,
      hasHeroCta: true,
      loadTimeSeconds: 2,
      hasSocialProof: true,
    },
    offers: {
      hasActiveOffer: true,
      offerTermsClear: true,
      offerExpiryShown: true,
      discountVisibleBeforeCheckout: true,
    },
    cta: {
      ctaText: 'Add to Cart',
      ctaAboveFold: true,
      ctaButtonCount: 1,
      ctaContrastSufficient: true,
    },
    trustSignals: {
      hasSecurityBadges: true,
      hasReturnPolicyVisible: true,
      hasMoneyBackGuarantee: true,
      hasCustomerReviews: true,
      hasContactInfoVisible: true,
    },
    checkoutFriction: {
      stepsToCheckout: 3,
      guestCheckoutAvailable: true,
      accountCreationRequired: false,
      paymentMethodsCount: 3,
      formFieldsCount: 6,
    },
    mobileExperience: {
      mobileResponsive: true,
      mobilePageSpeedScore: 80,
      tapTargetsAdequate: true,
      mobileCheckoutOptimized: true,
    },
    pricingPresentation: {
      priceClearlyDisplayed: true,
      compareAtPriceShown: true,
      shippingCostShownBeforeCheckout: true,
      currencyClear: true,
      allCostsShownBeforeCheckout: true,
    },
  };
}

// --- baseline: nothing supplied stays honestly empty, never fabricated -------------------

test('a call with nothing supplied reports every dimension empty, a 0% score, and 8 dimension_gaps', () => {
  const result = checkConversionOptimization({});
  for (const status of Object.values(result.dimension_status)) {
    assert.strictEqual(status, 'empty');
  }
  assert.strictEqual(result.quality_score.percentage, 0);
  assert.strictEqual(result.quality_score.status, 'empty');
  assert.strictEqual(result.dimension_gaps.length, 8);
  assert.deepStrictEqual(result.findings, [
    '[Product pages] No product page evidence was supplied to audit.',
    '[Landing pages] No landing page evidence was supplied to audit.',
    '[Offers] No active offer was supplied to audit.',
    '[CTA] No CTA evidence was supplied to audit.',
    '[Trust signals] No trust signal evidence was supplied to audit.',
    '[Checkout friction] No checkout evidence was supplied to audit.',
    '[Mobile experience] No mobile experience evidence was supplied to audit.',
    '[Pricing presentation] No pricing presentation evidence was supplied to audit.',
  ]);
});

// --- a fully-populated, fully-passing evidence set reports success everywhere ------------

test('a fully-populated evidence set reports success on every dimension, a 100% score, and zero gaps', () => {
  const result = checkConversionOptimization(fullEvidence());
  for (const [dimension, status] of Object.entries(result.dimension_status)) {
    assert.strictEqual(status, 'success', `expected ${dimension} to be success`);
  }
  assert.strictEqual(result.quality_score.percentage, 100);
  assert.strictEqual(result.quality_score.status, 'success');
  assert.deepStrictEqual(result.dimension_gaps, []);
  assert.deepStrictEqual(result.recommendations, []);
  assert.deepStrictEqual(result.prioritized_recommendations, []);
});

// --- product_pages -------------------------------------------------------------------------

test('product_pages is partial and flags an image count below the conventional guideline', () => {
  const result = checkConversionOptimization({
    productPages: { imagesCount: 2, hasDescription: true, hasPriceDisplayed: true, hasAvailabilityStatus: true, hasCustomerReviews: true },
  });
  assert.strictEqual(result.dimension_status.product_pages, 'partial');
  assert.ok(result.findings.some((f) => f.includes('conventional guideline: at least 3')));
});

// --- landing_pages ---------------------------------------------------------------------------

test('landing_pages flags a load time over the conventional guideline as critical', () => {
  const result = checkConversionOptimization({
    landingPages: { hasClearHeadline: true, hasValueProposition: true, hasHeroCta: true, loadTimeSeconds: 5, hasSocialProof: true },
  });
  assert.strictEqual(result.dimension_status.landing_pages, 'partial');
  const entry = result.prioritized_recommendations.find((r) => r.dimension === 'landing_pages');
  assert.strictEqual(entry.severity, 'critical');
});

// --- offers ----------------------------------------------------------------------------------

test('offers is empty (not a failure) when no active offer is supplied', () => {
  const result = checkConversionOptimization({});
  assert.strictEqual(result.dimension_status.offers, 'empty');
  assert.ok(!result.recommendations.some((r) => r.startsWith('[Offers]')));
});

test('offers is partial once an active offer exists but its checks are unmet', () => {
  const result = checkConversionOptimization({
    offers: { hasActiveOffer: true, offerTermsClear: false, offerExpiryShown: false, discountVisibleBeforeCheckout: false },
  });
  assert.strictEqual(result.dimension_status.offers, 'partial');
  assert.ok(result.recommendations.some((r) => r.includes('Clarify the offer terms')));
});

// --- cta -------------------------------------------------------------------------------------

test('cta flags missing CTA text as critical', () => {
  const result = checkConversionOptimization({
    cta: { ctaAboveFold: true, ctaButtonCount: 1, ctaContrastSufficient: true },
  });
  const entry = result.prioritized_recommendations.find((r) => r.recommendation.includes('Add clear CTA text'));
  assert.strictEqual(entry.severity, 'critical');
});

test('cta flags a button count over the conventional guideline as low severity', () => {
  const result = checkConversionOptimization({
    cta: { ctaText: 'Buy Now', ctaAboveFold: true, ctaButtonCount: 5, ctaContrastSufficient: true },
  });
  const entry = result.prioritized_recommendations.find((r) => r.recommendation.includes('Reduce the number of competing CTA buttons'));
  assert.strictEqual(entry.severity, 'low');
});

// --- trust_signals -----------------------------------------------------------------------------

test('trust_signals flags a missing security badge', () => {
  const result = checkConversionOptimization({
    trustSignals: { hasSecurityBadges: false, hasReturnPolicyVisible: true, hasMoneyBackGuarantee: true, hasCustomerReviews: true, hasContactInfoVisible: true },
  });
  assert.strictEqual(result.dimension_status.trust_signals, 'partial');
  assert.ok(result.recommendations.some((r) => r.includes('Add security/payment trust badges')));
});

// --- checkout_friction -------------------------------------------------------------------------

test('checkout_friction flags too many steps, no guest checkout, and required account creation as critical', () => {
  const result = checkConversionOptimization({
    checkoutFriction: { stepsToCheckout: 6, guestCheckoutAvailable: false, accountCreationRequired: true, paymentMethodsCount: 3, formFieldsCount: 6 },
  });
  const critical = result.prioritized_recommendations
    .filter((r) => r.dimension === 'checkout_friction' && r.severity === 'critical')
    .map((r) => r.recommendation);
  assert.strictEqual(critical.length, 3);
});

// --- mobile_experience -------------------------------------------------------------------------

test('mobile_experience flags a non-responsive layout as critical and a low page speed score as high', () => {
  const result = checkConversionOptimization({
    mobileExperience: { mobileResponsive: false, mobilePageSpeedScore: 42, tapTargetsAdequate: true, mobileCheckoutOptimized: true },
  });
  const responsive = result.prioritized_recommendations.find((r) => r.recommendation.includes('mobile-responsive'));
  const speed = result.prioritized_recommendations.find((r) => r.recommendation.includes('Improve mobile page speed'));
  assert.strictEqual(responsive.severity, 'critical');
  assert.strictEqual(speed.severity, 'high');
});

// --- pricing_presentation -----------------------------------------------------------------------

test('pricing_presentation flags hidden shipping cost and hidden fees as critical', () => {
  const result = checkConversionOptimization({
    pricingPresentation: { priceClearlyDisplayed: true, compareAtPriceShown: true, shippingCostShownBeforeCheckout: false, currencyClear: true, allCostsShownBeforeCheckout: false },
  });
  const critical = result.prioritized_recommendations
    .filter((r) => r.dimension === 'pricing_presentation' && r.severity === 'critical')
    .map((r) => r.recommendation);
  assert.strictEqual(critical.length, 2);
});

// --- prioritized_recommendations ordering ---------------------------------------------------

test('prioritized_recommendations is sorted by severity tier, ties broken by dimension order', () => {
  const result = checkConversionOptimization({
    pricingPresentation: { priceClearlyDisplayed: true, compareAtPriceShown: false, shippingCostShownBeforeCheckout: true, currencyClear: true, allCostsShownBeforeCheckout: true },
    productPages: { imagesCount: 3, hasDescription: true, hasPriceDisplayed: true, hasAvailabilityStatus: false, hasCustomerReviews: true },
    checkoutFriction: { stepsToCheckout: 6, guestCheckoutAvailable: true, accountCreationRequired: false, paymentMethodsCount: 3, formFieldsCount: 6 },
  });
  const severities = result.prioritized_recommendations.map((r) => r.severity);
  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  for (let i = 1; i < severities.length; i += 1) {
    assert.ok(rank[severities[i - 1]] <= rank[severities[i]], 'severities must be non-decreasing');
  }
  // checkout_friction (critical) precedes product_pages (medium) precedes pricing_presentation (low).
  assert.strictEqual(result.prioritized_recommendations[0].dimension, 'checkout_friction');
  assert.strictEqual(result.prioritized_recommendations[0].severity, 'critical');
  assert.strictEqual(result.prioritized_recommendations[result.prioritized_recommendations.length - 1].dimension, 'pricing_presentation');
});

// --- specialized_records traceability -----------------------------------------------------------

test('specialized_records echoes back exactly the caller-supplied evidence per dimension, and null where absent', () => {
  const productPages = { imagesCount: 3, hasDescription: true, hasPriceDisplayed: true, hasAvailabilityStatus: true, hasCustomerReviews: true };
  const result = checkConversionOptimization({ productPages });
  assert.deepStrictEqual(result.specialized_records.product_pages, productPages);
  assert.strictEqual(result.specialized_records.landing_pages, null);
  assert.strictEqual(result.specialized_records.offers, null);
});

// --- research_date ---------------------------------------------------------------------------

test('research_date defaults to today\'s ISO date when not supplied', () => {
  const result = checkConversionOptimization({});
  const today = new Date().toISOString().slice(0, 10);
  assert.strictEqual(result.research_date, today);
});

test('research_date honors a caller-supplied value', () => {
  const result = checkConversionOptimization({ researchDate: '2025-01-01' });
  assert.strictEqual(result.research_date, '2025-01-01');
});

// --- honesty: no fabricated conversion-rate/impact claim anywhere -------------------------------

test('the result never contains a fabricated conversion-rate/impact prediction anywhere', () => {
  const result = checkConversionOptimization(fullEvidence());
  const serialized = JSON.stringify(result).toLowerCase();
  for (const bannedTerm of ['will increase', 'will convert', 'guaranteed', '% lift', 'roi of', 'predicted conversion']) {
    assert.ok(!serialized.includes(bannedTerm), `result must not contain "${bannedTerm}"`);
  }
});

test('every recommendation is prefixed with its dimension label for traceability', () => {
  const result = checkConversionOptimization({
    cta: { ctaAboveFold: false, ctaButtonCount: 0, ctaContrastSufficient: false },
  });
  for (const recommendation of result.recommendations) {
    assert.ok(/^\[[A-Za-z -]+\]/.test(recommendation), `"${recommendation}" is missing a [Dimension] prefix`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
