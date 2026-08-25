'use strict';

const assert = require('node:assert');
const {
  deriveCrossAgentContext,
  deriveAllToAnalyticsContext,
  gatherGrowthOpportunityDrafts,
  mergeContext,
  filterToDeclaredFields,
  dedupeArray,
} = require('../../agent/core/crossAgentContext');

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

// --- helpers -------------------------------------------------------------------
//
// Every multi-capability tool (the only kind any declared flow reads from) wraps its
// real specialist envelope in its own {status, result, error} shape - see
// agent/core/crossAgentContext.js's realOutput() and its header comment. Fixtures
// here reproduce that exact wrapper, verified directly against real orchestrator runs
// (not assumed), so these unit tests match what agent/core/orchestratorExecutionContract.js
// actually produces.

function step({ specialistId, capabilityId, result }) {
  return {
    selected_specialist: { type: 'specialist', id: specialistId, title: specialistId },
    inputs: { capability_id: capabilityId },
    outputs: { status: 'success', result, error: null },
  };
}

// --- dedupeArray -----------------------------------------------------------------

test('dedupeArray removes duplicate strings, keeping first-seen order', () => {
  assert.deepStrictEqual(dedupeArray(['a', 'b', 'a', 'c', 'b']), ['a', 'b', 'c']);
});

test('dedupeArray removes duplicate objects by deep equality', () => {
  const result = dedupeArray([{ x: 1 }, { x: 2 }, { x: 1 }]);
  assert.deepStrictEqual(result, [{ x: 1 }, { x: 2 }]);
});

// --- mergeContext ------------------------------------------------------------------

test('mergeContext adds a new scalar field', () => {
  assert.deepStrictEqual(mergeContext({}, { product: 'Jacket' }), { product: 'Jacket' });
});

test('mergeContext never overwrites an already-set scalar field', () => {
  const accumulator = { product: 'Jacket' };
  mergeContext(accumulator, { product: 'Something else' });
  assert.strictEqual(accumulator.product, 'Jacket');
});

test('mergeContext concatenates and dedupes array fields across contributions', () => {
  const accumulator = { evidence: ['a', 'b'] };
  mergeContext(accumulator, { evidence: ['b', 'c'] });
  assert.deepStrictEqual(accumulator.evidence, ['a', 'b', 'c']);
});

// --- filterToDeclaredFields ---------------------------------------------------------

test('filterToDeclaredFields keeps only required/optional keys the input_contract declares', () => {
  const inputContract = { required: ['productReference'], optional: ['evidence'] };
  const result = filterToDeclaredFields(
    { productReference: 'X', evidence: ['y'], notDeclared: 'z' },
    inputContract
  );
  assert.deepStrictEqual(result, { productReference: 'X', evidence: ['y'] });
});

test('filterToDeclaredFields returns {} when inputContract is missing', () => {
  assert.deepStrictEqual(filterToDeclaredFields({ x: 1 }, null), {});
});

// --- deriveCrossAgentContext: unknown/undeclared targets ---------------------------

test('deriveCrossAgentContext returns {} when the target capability does not exist', () => {
  const result = deriveCrossAgentContext({
    completedSteps: [],
    toSpecialistId: 'seo',
    toCapabilityId: 'not_a_real_capability',
  });
  assert.deepStrictEqual(result, {});
});

test('deriveCrossAgentContext returns {} when no declared flow applies (e.g. SEO -> Marketing is not a listed flow)', () => {
  const priorSeoStep = step({
    specialistId: 'seo',
    capabilityId: 'product_seo',
    result: {
      specialized_records: [{ product_reference: 'x', product_title: 'Insulated Jacket', description: 'Warm.', keywords: ['jacket'] }],
    },
  });
  const result = deriveCrossAgentContext({
    completedSteps: [priorSeoStep],
    toSpecialistId: 'marketing',
    toCapabilityId: 'marketing_strategy',
  });
  assert.deepStrictEqual(result, {});
});

// --- Flow 1: Research -> Product ----------------------------------------------------

test('Research -> Product: market_research feeds demandEvidence with the real topic/market/findings/source/confidence', () => {
  const priorStep = step({
    specialistId: 'research',
    capabilityId: 'market_research',
    result: {
      topic: 'European hiking apparel market',
      market: 'European Union',
      findings: ['Rising demand for sustainable materials.', 'Growing interest in insulated layers.'],
      source: ['(placeholder market report)'],
      confidence: 'medium',
      verification_status: 'unverified',
    },
  });
  const result = deriveCrossAgentContext({
    completedSteps: [priorStep],
    toSpecialistId: 'product',
    toCapabilityId: 'product_opportunity_analysis',
  });
  assert.deepStrictEqual(result, {
    demandEvidence: [
      {
        topic: 'European hiking apparel market',
        market: 'European Union',
        source: ['(placeholder market report)'],
        finding: 'Rising demand for sustainable materials.; Growing interest in insulated layers.',
        confidence: 'medium',
        verificationStatus: 'unverified',
      },
    ],
  });
});

test('Research -> Product: competitor_research feeds competitionEvidence, not demandEvidence', () => {
  const priorStep = step({
    specialistId: 'research',
    capabilityId: 'competitor_research',
    result: {
      topic: 'Competitor X',
      market: 'European Union',
      findings: ['Competitor X undercuts on price.'],
      source: ['(placeholder competitor report)'],
      confidence: 'high',
      verification_status: 'verified',
    },
  });
  const result = deriveCrossAgentContext({
    completedSteps: [priorStep],
    toSpecialistId: 'product',
    toCapabilityId: 'product_opportunity_analysis',
  });
  assert.ok(result.competitionEvidence);
  assert.strictEqual(result.demandEvidence, undefined);
  assert.strictEqual(result.competitionEvidence[0].finding, 'Competitor X undercuts on price.');
});

test('Research -> Product: a research type with no findings contributes nothing', () => {
  const priorStep = step({
    specialistId: 'research',
    capabilityId: 'market_research',
    result: { topic: 'x', market: '', findings: [], source: [], confidence: 'unassessed', verification_status: 'unverified' },
  });
  const result = deriveCrossAgentContext({
    completedSteps: [priorStep],
    toSpecialistId: 'product',
    toCapabilityId: 'product_opportunity_analysis',
  });
  assert.deepStrictEqual(result, {});
});

// --- Flow 2: Product -> Listing ------------------------------------------------------

test('Product -> Listing: product_opportunity_analysis feeds productInfo.description and market', () => {
  const priorStep = step({
    specialistId: 'product',
    capabilityId: 'product_opportunity_analysis',
    result: {
      product_identity: 'Insulated Jacket',
      market: 'European Union',
      specialized_records: { product_record: { description: 'A warm, sustainable jacket.' } },
    },
  });
  const result = deriveCrossAgentContext({
    completedSteps: [priorStep],
    toSpecialistId: 'listing',
    toCapabilityId: 'listing_content',
  });
  assert.deepStrictEqual(result, {
    productInfo: { description: 'A warm, sustainable jacket.' },
    market: 'European Union',
  });
});

test('Product -> Listing: marketplace_format has no productInfo/market in its input_contract, so nothing is injected', () => {
  const priorStep = step({
    specialistId: 'product',
    capabilityId: 'product_opportunity_analysis',
    result: {
      product_identity: 'Insulated Jacket',
      market: 'European Union',
      specialized_records: { product_record: { description: 'A warm jacket.' } },
    },
  });
  const result = deriveCrossAgentContext({
    completedSteps: [priorStep],
    toSpecialistId: 'listing',
    toCapabilityId: 'marketplace_format',
  });
  assert.deepStrictEqual(result, {});
});

// --- Flow 3: SEO -> Listing ----------------------------------------------------------

test('SEO -> Listing: product_seo feeds seoRecommendations with the real product_title/description/keywords fields directly (no rename needed)', () => {
  const priorStep = step({
    specialistId: 'seo',
    capabilityId: 'product_seo',
    result: {
      specialized_records: [
        { product_reference: 'x', product_title: 'Insulated Hiking Jacket', description: 'SEO-optimized description.', keywords: ['insulated jacket', 'hiking gear'] },
      ],
    },
  });
  const result = deriveCrossAgentContext({
    completedSteps: [priorStep],
    toSpecialistId: 'listing',
    toCapabilityId: 'listing_content',
  });
  assert.deepStrictEqual(result, {
    seoRecommendations: {
      product_title: 'Insulated Hiking Jacket',
      description: 'SEO-optimized description.',
      keywords: ['insulated jacket', 'hiking gear'],
    },
  });
});

test('SEO -> Listing: on_page_seo dispatched to a collection/content (no product_title field) does not feed listing_content - detected structurally, not by capability id alone', () => {
  const priorStep = step({
    specialistId: 'seo',
    capabilityId: 'on_page_seo',
    result: {
      // A real agent/core/onPageOptimizationModel.js record (collection/content
      // subject) - no product_title field, unlike product_seo's
      // listingOptimizationModel.js record above.
      specialized_records: [{ subject_type: 'collection', subject_reference: 'x', subject_title: 'Winter Collection', description: 'x', keywords: ['winter'] }],
    },
  });
  const result = deriveCrossAgentContext({
    completedSteps: [priorStep],
    toSpecialistId: 'listing',
    toCapabilityId: 'listing_content',
  });
  assert.deepStrictEqual(result, {});
});

test('SEO -> Listing: collection_seo/content_seo results are not even considered - only product_seo/on_page_seo are gated in', () => {
  const priorStep = step({
    specialistId: 'seo',
    capabilityId: 'collection_seo',
    result: {
      specialized_records: [{ subject_type: 'collection', subject_reference: 'x', subject_title: 'Winter Collection', description: 'x', keywords: ['winter'] }],
    },
  });
  const result = deriveCrossAgentContext({
    completedSteps: [priorStep],
    toSpecialistId: 'listing',
    toCapabilityId: 'listing_content',
  });
  assert.deepStrictEqual(result, {});
});

test('Research + SEO in the same plan both contribute to different downstream fields, without colliding', () => {
  const researchStep = step({
    specialistId: 'research',
    capabilityId: 'market_research',
    result: { topic: 't', market: 'EU', findings: ['f'], source: ['s'], confidence: 'medium', verification_status: 'unverified' },
  });
  const seoStep = step({
    specialistId: 'seo',
    capabilityId: 'product_seo',
    result: { specialized_records: [{ product_reference: 'x', product_title: 'Title', description: 'Desc', keywords: ['k'] }] },
  });
  const result = deriveCrossAgentContext({
    completedSteps: [researchStep, seoStep],
    toSpecialistId: 'listing',
    toCapabilityId: 'listing_content',
  });
  assert.deepStrictEqual(result, { seoRecommendations: { product_title: 'Title', description: 'Desc', keywords: ['k'] } });
});

// --- Flow 4: Product -> Marketing -----------------------------------------------------

test('Product -> Marketing: product_opportunity_analysis feeds `product` (a string) and `evidence` for marketing_strategy', () => {
  const priorStep = step({
    specialistId: 'product',
    capabilityId: 'product_opportunity_analysis',
    result: { product_identity: 'Insulated Jacket', source: ['(placeholder source)'] },
  });
  const result = deriveCrossAgentContext({
    completedSteps: [priorStep],
    toSpecialistId: 'marketing',
    toCapabilityId: 'marketing_strategy',
  });
  assert.deepStrictEqual(result, { product: 'Insulated Jacket', evidence: ['(placeholder source)'] });
});

test('Product -> Marketing: retention gets productReference (its required field), not `product`', () => {
  const priorStep = step({
    specialistId: 'product',
    capabilityId: 'product_opportunity_analysis',
    result: { product_identity: 'Insulated Jacket', source: [] },
  });
  const result = deriveCrossAgentContext({
    completedSteps: [priorStep],
    toSpecialistId: 'marketing',
    toCapabilityId: 'retention',
  });
  assert.deepStrictEqual(result, { productReference: 'Insulated Jacket' });
});

test('Product -> Marketing: campaign_planning has no product/productReference in its input_contract, so nothing is injected', () => {
  const priorStep = step({
    specialistId: 'product',
    capabilityId: 'product_opportunity_analysis',
    result: { product_identity: 'Insulated Jacket', source: [] },
  });
  const result = deriveCrossAgentContext({
    completedSteps: [priorStep],
    toSpecialistId: 'marketing',
    toCapabilityId: 'campaign_planning',
  });
  assert.deepStrictEqual(result, {});
});

// --- Flow 5: Marketing -> Social & Advertising -----------------------------------------

test('Marketing -> Social & Advertising: campaign_planning feeds content_calendar\'s campaignContext, camelCase-reshaped', () => {
  const priorStep = step({
    specialistId: 'marketing',
    capabilityId: 'campaign_planning',
    result: {
      specialized_records: [
        {
          campaign_reference: 'Winter Launch',
          objective: 'Drive awareness',
          audience: 'Hikers',
          offer: '10% off',
          message: 'Stay warm',
          channel: 'email',
          creative_direction: 'Cozy imagery',
          cta: 'Shop now',
          kpi: ['CTR'],
          measurement_plan: ['Track CTR weekly'],
          evidence: ['(placeholder)'],
          verification_status: 'unverified',
        },
      ],
    },
  });
  const result = deriveCrossAgentContext({
    completedSteps: [priorStep],
    toSpecialistId: 'social_advertising',
    toCapabilityId: 'content_calendar',
  });
  assert.deepStrictEqual(result, {
    campaignContext: {
      campaignReference: 'Winter Launch',
      objective: 'Drive awareness',
      audience: 'Hikers',
      offer: '10% off',
      message: 'Stay warm',
      channel: 'email',
      creativeDirection: 'Cozy imagery',
      cta: 'Shop now',
      kpi: ['CTR'],
      measurementPlan: ['Track CTR weekly'],
      evidence: ['(placeholder)'],
      verificationStatus: 'unverified',
    },
  });
});

test('Marketing -> Social & Advertising: only content_calendar accepts campaignContext, not instagram', () => {
  const priorStep = step({
    specialistId: 'marketing',
    capabilityId: 'campaign_planning',
    result: { specialized_records: [{ campaign_reference: 'Winter Launch' }] },
  });
  const result = deriveCrossAgentContext({
    completedSteps: [priorStep],
    toSpecialistId: 'social_advertising',
    toCapabilityId: 'instagram',
  });
  assert.deepStrictEqual(result, {});
});

// --- Non-override: explicit researchParams always wins -----------------------------

test('deriveCrossAgentContext never overrides a field the caller already explicitly supplied', () => {
  const priorStep = step({
    specialistId: 'product',
    capabilityId: 'product_opportunity_analysis',
    result: { product_identity: 'Insulated Jacket', source: [] },
  });
  const result = deriveCrossAgentContext({
    completedSteps: [priorStep],
    toSpecialistId: 'marketing',
    toCapabilityId: 'retention',
    existingResearchParams: { productReference: 'Caller-supplied Value' },
  });
  assert.deepStrictEqual(result, {});
});

// --- "All -> Analytics" -------------------------------------------------------------

test('All -> Analytics: a Marketing retention record feeds growth_opportunities.opportunities', () => {
  const priorStep = step({
    specialistId: 'marketing',
    capabilityId: 'retention',
    result: {
      specialized_records: [
        {
          opportunity_type: 'retention',
          product_reference: 'Insulated Jacket',
          related_products: [],
          target_segment: 'Lapsed customers',
          offer: 'Win-back 15% off',
          recommendation: 'Send a win-back email.',
          evidence: ['(placeholder)'],
          verification_status: 'unverified',
        },
      ],
    },
  });
  const context = deriveAllToAnalyticsContext([priorStep], 'growth_opportunities');
  assert.deepStrictEqual(context, {
    opportunities: [
      {
        productReference: 'Insulated Jacket',
        opportunityType: 'retention',
        relatedProducts: [],
        targetSegment: 'Lapsed customers',
        offer: 'Win-back 15% off',
        recommendation: 'Send a win-back email.',
        evidence: ['(placeholder)'],
        verificationStatus: 'unverified',
      },
    ],
  });
});

test('All -> Analytics: only growth_opportunities is fed - other Analytics capabilities get nothing', () => {
  const priorStep = step({
    specialistId: 'marketing',
    capabilityId: 'retention',
    result: { specialized_records: [{ opportunity_type: 'retention', product_reference: 'X', related_products: [], target_segment: '', offer: '', recommendation: '', evidence: [], verification_status: 'unverified' }] },
  });
  assert.deepStrictEqual(deriveAllToAnalyticsContext([priorStep], 'sales'), {});
});

test('All -> Analytics: dedupes an identical opportunity record contributed by two different steps', () => {
  const record = {
    opportunity_type: 'retention',
    product_reference: 'X',
    related_products: [],
    target_segment: '',
    offer: '',
    recommendation: 'Send an email.',
    evidence: [],
    verification_status: 'unverified',
  };
  const stepA = step({ specialistId: 'marketing', capabilityId: 'retention', result: { specialized_records: [record] } });
  const stepB = step({ specialistId: 'analytics_optimization', capabilityId: 'growth_opportunities', result: { specialized_records: [record] } });
  const context = deriveAllToAnalyticsContext([stepA, stepB], 'growth_opportunities');
  assert.strictEqual(context.opportunities.length, 1);
});

test('All -> Analytics: a step with no growth-opportunity-shaped output contributes nothing', () => {
  const priorStep = step({ specialistId: 'seo', capabilityId: 'product_seo', result: { specialized_records: [{ subject_type: 'product' }] } });
  assert.deepStrictEqual(deriveAllToAnalyticsContext([priorStep], 'growth_opportunities'), {});
});

// --- "Analytics -> Optimization" ----------------------------------------------------

test('gatherGrowthOpportunityDrafts maps opportunity_type to the engine\'s category via the documented rename, never inventing expectedImpactMagnitude/expectedImpactCategory/actionClassification', () => {
  const priorStep = step({
    specialistId: 'marketing',
    capabilityId: 'retention',
    result: {
      specialized_records: [
        {
          opportunity_type: 'retention',
          product_reference: 'Insulated Jacket',
          related_products: [],
          target_segment: 'Lapsed customers',
          offer: 'Win-back 15% off',
          recommendation: 'Send a win-back email.',
          evidence: ['(placeholder)'],
          verification_status: 'unverified',
        },
      ],
    },
  });
  const drafts = gatherGrowthOpportunityDrafts([priorStep]);
  assert.strictEqual(drafts.length, 1);
  const [draft] = drafts;
  assert.strictEqual(draft.category, 'retention');
  assert.strictEqual(draft.opportunity, 'Insulated Jacket: Send a win-back email.');
  assert.strictEqual(draft.reason, 'Segment: Lapsed customers; Offer: Win-back 15% off');
  assert.strictEqual(draft.requiredAction, 'Send a win-back email.');
  assert.deepStrictEqual(draft.evidence, ['(placeholder)']);
  assert.deepStrictEqual(draft.missing_for_ranking, ['expectedImpactCategory', 'expectedImpactMagnitude', 'actionClassification']);
  assert.strictEqual('expectedImpactMagnitude' in draft, false);
  assert.strictEqual('actionClassification' in draft, false);
});

test('gatherGrowthOpportunityDrafts maps upselling/cross_selling/repeat_purchases/customer_reengagement to \'conversion\'', () => {
  const types = ['upselling', 'cross_selling', 'repeat_purchases', 'customer_reengagement'];
  for (const opportunityType of types) {
    const priorStep = step({
      specialistId: 'marketing',
      capabilityId: 'conversion_opportunities',
      result: {
        specialized_records: [
          { opportunity_type: opportunityType, product_reference: 'X', related_products: [], target_segment: 'S', offer: '', recommendation: 'Do it.', evidence: [], verification_status: 'unverified' },
        ],
      },
    });
    const [draft] = gatherGrowthOpportunityDrafts([priorStep]);
    assert.strictEqual(draft.category, 'conversion', `${opportunityType} should map to conversion`);
  }
});

test('gatherGrowthOpportunityDrafts leaves category null (and flags it) for unclassified - never guessed', () => {
  const priorStep = step({
    specialistId: 'marketing',
    capabilityId: 'conversion_opportunities',
    result: {
      specialized_records: [{ opportunity_type: 'unclassified', product_reference: 'X', related_products: [], target_segment: '', offer: '', recommendation: '', evidence: [], verification_status: 'unverified' }],
    },
  });
  const [draft] = gatherGrowthOpportunityDrafts([priorStep]);
  assert.strictEqual(draft.category, null);
  assert.ok(draft.missing_for_ranking.includes('category'));
});

test('gatherGrowthOpportunityDrafts flags reason/requiredAction as missing when target_segment/offer/recommendation are all empty', () => {
  const priorStep = step({
    specialistId: 'marketing',
    capabilityId: 'retention',
    result: {
      specialized_records: [{ opportunity_type: 'retention', product_reference: 'X', related_products: [], target_segment: '', offer: '', recommendation: '', evidence: [], verification_status: 'unverified' }],
    },
  });
  const [draft] = gatherGrowthOpportunityDrafts([priorStep]);
  assert.strictEqual(draft.reason, '');
  assert.strictEqual(draft.requiredAction, '');
  assert.ok(draft.missing_for_ranking.includes('reason'));
  assert.ok(draft.missing_for_ranking.includes('requiredAction'));
});

test('gatherGrowthOpportunityDrafts returns [] when no step produced a growth-opportunity-shaped record', () => {
  const priorStep = step({ specialistId: 'seo', capabilityId: 'product_seo', result: { specialized_records: [{ subject_type: 'product' }] } });
  assert.deepStrictEqual(gatherGrowthOpportunityDrafts([priorStep]), []);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
