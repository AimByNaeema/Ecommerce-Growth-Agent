'use strict';

const assert = require('node:assert');
const { checkConversionOptimization } = require('../../agent/core/conversionOptimizationChecker');
const {
  CONVERSION_OPTIMIZATION_DIMENSIONS,
  validateConversionOptimizationCheckShape,
} = require('../../agent/core/conversionOptimizationCheckModel');

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

function assertValid(result) {
  const validation = validateConversionOptimizationCheckShape(result);
  assert.strictEqual(validation.valid, true, `expected valid, got errors: ${validation.errors.join(', ')}`);
}

// --- baseline: nothing supplied stays honestly empty, never fabricated -----------------

test('calling with no dimension evidence reports every dimension empty and a 0% score, never fabricated', () => {
  const result = checkConversionOptimization({ subjectReference: '(no evidence)' });
  assertValid(result);
  for (const status of Object.values(result.dimension_status)) {
    assert.strictEqual(status, 'empty');
  }
  assert.strictEqual(result.quality_score.percentage, 0);
  assert.strictEqual(result.quality_score.status, 'empty');
  assert.strictEqual(result.dimension_gaps.length, CONVERSION_OPTIMIZATION_DIMENSIONS.length);
  assert.deepStrictEqual(result.recommendations, []);
  assert.deepStrictEqual(result.prioritized_recommendations, []);
});

test('subject_reference defaults to empty string and is echoed back when supplied', () => {
  const result = checkConversionOptimization({ subjectReference: '(Example store homepage)' });
  assert.strictEqual(result.subject_reference, '(Example store homepage)');
});

// --- a fully-passing store reports success across every dimension ----------------------

test('fully-passing evidence across all 8 dimensions reports success and a 100% score', () => {
  const result = checkConversionOptimization({
    subjectReference: 'sku-1',
    productPages: {
      imagesCount: 5,
      hasDescription: true,
      hasPriceDisplayed: true,
      hasAvailabilityStatus: true,
      hasCustomerReviews: true,
    },
    landingPages: {
      hasClearHeadline: true,
      hasValueProposition: true,
      hasHeroCta: true,
      loadTimeSeconds: 1.5,
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
  });

  assertValid(result);
  for (const [dimension, status] of Object.entries(result.dimension_status)) {
    assert.strictEqual(status, 'success', `expected ${dimension} to be success`);
  }
  assert.strictEqual(result.quality_score.percentage, 100);
  assert.strictEqual(result.quality_score.status, 'success');
  assert.deepStrictEqual(result.dimension_gaps, []);
  assert.deepStrictEqual(result.recommendations, []);
  assert.deepStrictEqual(result.prioritized_recommendations, []);
});

// --- product_pages -----------------------------------------------------------------------

test('product_pages is empty when no evidence is supplied', () => {
  const result = checkConversionOptimization({});
  assert.strictEqual(result.dimension_status.product_pages, 'empty');
  assert.ok(result.findings.some((f) => f === '[Product pages] No product page evidence was supplied to audit.'));
});

test('product_pages is partial and flags a below-guideline image count', () => {
  const result = checkConversionOptimization({
    productPages: { imagesCount: 1, hasDescription: true, hasPriceDisplayed: true, hasAvailabilityStatus: true, hasCustomerReviews: true },
  });
  assert.strictEqual(result.dimension_status.product_pages, 'partial');
  assert.ok(result.recommendations.some((r) => r.includes('Add more product images')));
});

// --- landing_pages -----------------------------------------------------------------------

test('landing_pages is empty when no evidence is supplied', () => {
  const result = checkConversionOptimization({});
  assert.strictEqual(result.dimension_status.landing_pages, 'empty');
});

test('landing_pages flags a load time above the conventional threshold', () => {
  const result = checkConversionOptimization({
    landingPages: { hasClearHeadline: true, hasValueProposition: true, hasHeroCta: true, loadTimeSeconds: 6, hasSocialProof: true },
  });
  assert.strictEqual(result.dimension_status.landing_pages, 'partial');
  assert.ok(result.findings.some((f) => f.includes('conventional guideline: 3s')));
  assert.ok(
    result.prioritized_recommendations.some((r) => r.dimension === 'landing_pages' && r.severity === 'critical')
  );
});

// --- offers ------------------------------------------------------------------------------

test('offers is honestly empty (not a failure) when there is no active offer', () => {
  const result = checkConversionOptimization({ offers: { hasActiveOffer: false } });
  assert.strictEqual(result.dimension_status.offers, 'empty');
  assert.ok(!result.recommendations.some((r) => r.startsWith('[Offers]')));
});

test('offers is empty when the offers object itself is not supplied at all', () => {
  const result = checkConversionOptimization({});
  assert.strictEqual(result.dimension_status.offers, 'empty');
});

test('offers is partial when an active offer has unclear terms', () => {
  const result = checkConversionOptimization({
    offers: { hasActiveOffer: true, offerTermsClear: false, offerExpiryShown: true, discountVisibleBeforeCheckout: true },
  });
  assert.strictEqual(result.dimension_status.offers, 'partial');
  assert.ok(result.recommendations.some((r) => r.includes('Clarify the offer terms')));
});

// --- cta ---------------------------------------------------------------------------------

test('cta is empty when no evidence is supplied', () => {
  const result = checkConversionOptimization({});
  assert.strictEqual(result.dimension_status.cta, 'empty');
});

test('cta flags missing CTA text and a missing CTA button as critical', () => {
  const result = checkConversionOptimization({
    cta: { ctaText: '', ctaAboveFold: false, ctaButtonCount: 0, ctaContrastSufficient: false },
  });
  assert.strictEqual(result.dimension_status.cta, 'partial');
  const ctaCritical = result.prioritized_recommendations.filter((r) => r.dimension === 'cta' && r.severity === 'critical');
  assert.ok(ctaCritical.length >= 2);
});

test('cta over-button-count check only applies once at least one CTA button exists', () => {
  const result = checkConversionOptimization({
    cta: { ctaText: 'Buy', ctaAboveFold: true, ctaButtonCount: 0, ctaContrastSufficient: true },
  });
  // ctaButtonCount is 0, so the "too many buttons" check must not fire at all -
  // only the "no CTA button present" check should be flagged.
  assert.ok(!result.recommendations.some((r) => r.includes('Reduce the number of competing CTA buttons')));
});

test('cta flags too many competing CTA buttons as low severity', () => {
  const result = checkConversionOptimization({
    cta: { ctaText: 'Buy', ctaAboveFold: true, ctaButtonCount: 5, ctaContrastSufficient: true },
  });
  assert.ok(
    result.prioritized_recommendations.some(
      (r) => r.dimension === 'cta' && r.severity === 'low' && r.recommendation.includes('Reduce the number of competing CTA buttons')
    )
  );
});

// --- trust_signals -----------------------------------------------------------------------

test('trust_signals is empty when no evidence is supplied', () => {
  const result = checkConversionOptimization({});
  assert.strictEqual(result.dimension_status.trust_signals, 'empty');
});

test('trust_signals flags missing security badges', () => {
  const result = checkConversionOptimization({
    trustSignals: { hasSecurityBadges: false, hasReturnPolicyVisible: true, hasMoneyBackGuarantee: true, hasCustomerReviews: true, hasContactInfoVisible: true },
  });
  assert.strictEqual(result.dimension_status.trust_signals, 'partial');
  assert.ok(result.recommendations.some((r) => r.includes('Add security/payment trust badges')));
});

// --- checkout_friction -------------------------------------------------------------------

test('checkout_friction is empty when no evidence is supplied', () => {
  const result = checkConversionOptimization({});
  assert.strictEqual(result.dimension_status.checkout_friction, 'empty');
});

test('checkout_friction flags mandatory account creation and no guest checkout as critical', () => {
  const result = checkConversionOptimization({
    checkoutFriction: {
      stepsToCheckout: 2,
      guestCheckoutAvailable: false,
      accountCreationRequired: true,
      paymentMethodsCount: 3,
      formFieldsCount: 5,
    },
  });
  assert.strictEqual(result.dimension_status.checkout_friction, 'partial');
  const critical = result.prioritized_recommendations.filter((r) => r.dimension === 'checkout_friction' && r.severity === 'critical');
  assert.ok(critical.some((r) => r.recommendation.includes('guest checkout')));
  assert.ok(critical.some((r) => r.recommendation.includes('Remove the requirement to create an account')));
});

test('checkout_friction flags too many steps and too many form fields', () => {
  const result = checkConversionOptimization({
    checkoutFriction: {
      stepsToCheckout: 6,
      guestCheckoutAvailable: true,
      accountCreationRequired: false,
      paymentMethodsCount: 1,
      formFieldsCount: 12,
    },
  });
  assert.ok(result.findings.some((f) => f.includes('conventional guideline: at most 4')));
  assert.ok(result.recommendations.some((r) => r.includes('Offer at least 2 payment methods')));
  assert.ok(result.recommendations.some((r) => r.includes('Reduce the checkout form to at most 8 fields')));
});

// --- mobile_experience -------------------------------------------------------------------

test('mobile_experience is empty when no evidence is supplied', () => {
  const result = checkConversionOptimization({});
  assert.strictEqual(result.dimension_status.mobile_experience, 'empty');
});

test('mobile_experience flags a below-threshold mobile page speed score', () => {
  const result = checkConversionOptimization({
    mobileExperience: { mobileResponsive: true, mobilePageSpeedScore: 20, tapTargetsAdequate: true, mobileCheckoutOptimized: true },
  });
  assert.strictEqual(result.dimension_status.mobile_experience, 'partial');
  assert.ok(result.findings.some((f) => f.includes('conventional guideline: 50+')));
});

// --- pricing_presentation ------------------------------------------------------------------

test('pricing_presentation is empty when no evidence is supplied', () => {
  const result = checkConversionOptimization({});
  assert.strictEqual(result.dimension_status.pricing_presentation, 'empty');
});

test('pricing_presentation flags hidden shipping cost and hidden fees as critical', () => {
  const result = checkConversionOptimization({
    pricingPresentation: {
      priceClearlyDisplayed: true,
      compareAtPriceShown: true,
      shippingCostShownBeforeCheckout: false,
      currencyClear: true,
      allCostsShownBeforeCheckout: false,
    },
  });
  assert.strictEqual(result.dimension_status.pricing_presentation, 'partial');
  const critical = result.prioritized_recommendations.filter((r) => r.dimension === 'pricing_presentation' && r.severity === 'critical');
  assert.ok(critical.some((r) => r.recommendation.includes('Show shipping cost before checkout')));
  assert.ok(critical.some((r) => r.recommendation.includes('Disclose all costs')));
});

test('pricing_presentation flags a missing compare-at price as low severity only', () => {
  const result = checkConversionOptimization({
    pricingPresentation: {
      priceClearlyDisplayed: true,
      compareAtPriceShown: false,
      shippingCostShownBeforeCheckout: true,
      currencyClear: true,
      allCostsShownBeforeCheckout: true,
    },
  });
  const entry = result.prioritized_recommendations.find((r) => r.recommendation.includes('compare-at price'));
  assert.strictEqual(entry.severity, 'low');
});

// --- prioritized_recommendations ordering ---------------------------------------------------

test('prioritized_recommendations is sorted by severity tier, critical first', () => {
  const result = checkConversionOptimization({
    pricingPresentation: {
      priceClearlyDisplayed: true,
      compareAtPriceShown: false, // low
      shippingCostShownBeforeCheckout: false, // critical
      currencyClear: false, // medium
      allCostsShownBeforeCheckout: true,
    },
    trustSignals: {
      hasSecurityBadges: false, // high
      hasReturnPolicyVisible: true,
      hasMoneyBackGuarantee: true,
      hasCustomerReviews: true,
      hasContactInfoVisible: true,
    },
  });
  const severities = result.prioritized_recommendations.map((r) => r.severity);
  const severityRank = { critical: 0, high: 1, medium: 2, low: 3 };
  for (let i = 1; i < severities.length; i += 1) {
    assert.ok(
      severityRank[severities[i - 1]] <= severityRank[severities[i]],
      `severity order broken at index ${i}: ${severities.join(', ')}`
    );
  }
  assert.strictEqual(severities[0], 'critical');
  assert.strictEqual(severities[severities.length - 1], 'low');
});

// --- specialized_records traceability --------------------------------------------------------

test('specialized_records echoes back exactly the supplied evidence per dimension, null when absent', () => {
  const ctaEvidence = { ctaText: 'Buy', ctaAboveFold: true, ctaButtonCount: 1, ctaContrastSufficient: true };
  const result = checkConversionOptimization({ cta: ctaEvidence });
  assert.deepStrictEqual(result.specialized_records.cta, ctaEvidence);
  assert.strictEqual(result.specialized_records.offers, null);
});

// --- honesty: no fabricated conversion-rate/impact claim anywhere -------------------------------

test('the result never contains a fabricated conversion-rate/impact prediction anywhere', () => {
  const result = checkConversionOptimization({
    checkoutFriction: { stepsToCheckout: 6, guestCheckoutAvailable: false, accountCreationRequired: true, paymentMethodsCount: 1, formFieldsCount: 12 },
  });
  const serialized = JSON.stringify(result).toLowerCase();
  for (const bannedTerm of ['% increase', 'will convert', 'guaranteed', 'conversion_rate_prediction', '$']) {
    assert.ok(!serialized.includes(bannedTerm), `result must not contain "${bannedTerm}"`);
  }
});

test('every recommendation is prefixed with its dimension label for traceability', () => {
  const result = checkConversionOptimization({
    checkoutFriction: { stepsToCheckout: 6, guestCheckoutAvailable: false, accountCreationRequired: true, paymentMethodsCount: 1, formFieldsCount: 12 },
  });
  for (const recommendation of result.recommendations) {
    assert.ok(/^\[[A-Za-z -]+\]/.test(recommendation), `"${recommendation}" is missing a [Dimension] prefix`);
  }
});

test('this checker never fetches or modifies anything - it is a pure function of its input evidence', () => {
  const evidence = { ctaText: 'Buy', ctaAboveFold: true, ctaButtonCount: 1, ctaContrastSufficient: true };
  const first = checkConversionOptimization({ cta: { ...evidence }, researchDate: '2026-01-01' });
  const second = checkConversionOptimization({ cta: { ...evidence }, researchDate: '2026-01-01' });
  assert.deepStrictEqual(first, second);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
