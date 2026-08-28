'use strict';

// End-to-end tests for the complete controlled ecommerce growth workflow
// (agent/core/growthWorkflowOrchestrator.js):
//
//   Research -> Product -> Listing -> SEO -> Marketing -> Social & Advertising
//   -> Analytics -> Optimization
//
// Mirrors verification/testing/chiefToApprovalIntegration.test.js's conventions
// exactly (testAsync, withEnvConfigured, withMockedFetch, jsonResponse, a
// with-reclassified-tool helper) - controlled/mocked data throughout, no real network
// call. Proves three things the feature explicitly requires:
//   1. The Chief runs all 8 stages, in order, and real structured output from one
//      stage becomes the next stage's real input (not caller-supplied, not invented).
//   2. A consequential action (temporarily reclassified, since no real tool is
//      approval_required today - same documented gap chiefToApprovalIntegration.test.js
//      already works around) stops the workflow before executing, and only resumes
//      once a real decision is recorded.
//   3. A rejected decision never lets the gated action execute, and the workflow does
//      not proceed past it.

const assert = require('node:assert');
const { runGrowthWorkflow, resumeGrowthWorkflow, STAGE_KEYS } = require('../../agent/core/growthWorkflowOrchestrator');
const { TOOL_CLASSIFICATIONS } = require('../../agent/core/toolPermissions');
const { decideApprovalRequest } = require('../../approvals/approvalWorkflow');

let passed = 0;
let failed = 0;

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(`  ${err.message}`);
    failed += 1;
  }
}

function withEnvConfigured(fn) {
  const savedDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const savedToken = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
  process.env.SHOPIFY_STORE_DOMAIN = 'test-store.myshopify.com';
  process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = 'shpat_test-token-not-real';
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (savedDomain === undefined) delete process.env.SHOPIFY_STORE_DOMAIN;
      else process.env.SHOPIFY_STORE_DOMAIN = savedDomain;
      if (savedToken === undefined) delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
      else process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = savedToken;
    });
}

function withMockedFetch(mockImpl, fn) {
  const savedFetch = global.fetch;
  global.fetch = mockImpl;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      global.fetch = savedFetch;
    });
}

function withReclassifiedTool(toolId, classification, fn) {
  const original = TOOL_CLASSIFICATIONS[toolId];
  TOOL_CLASSIFICATIONS[toolId] = classification;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      TOOL_CLASSIFICATIONS[toolId] = original;
    });
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, statusText: 'status text', json: async () => body };
}

const SAMPLE_ORDER_NODE = {
  id: 'gid://shopify/Order/1',
  name: '#1001',
  createdAt: '2026-01-15T10:00:00Z',
  displayFinancialStatus: 'PAID',
  displayFulfillmentStatus: 'FULFILLED',
  currentTotalPriceSet: { shopMoney: { amount: '89.00', currencyCode: 'USD' } },
  lineItems: { edges: [{ node: { title: 'Insulated Jacket', quantity: 1, sku: 'JCK-001' } }] },
};

function ordersResponse(nodes) {
  return jsonResponse(200, { data: { orders: { edges: nodes.map((node) => ({ node })) } } });
}

// A realistic, controlled set of per-stage inputs covering every genuine business
// decision this pipeline requires (which market, which product, the listing's actual
// creative title, the calendar entry's date/platform) - never anything this pipeline
// could honestly auto-derive itself.
function buildStageInputs() {
  return {
    research: {
      markets: [
        {
          country: 'DE',
          market: 'European Union',
          category: 'outdoor apparel',
          demandSignals: ['strong demand signal'],
          trends: ['sustainability trend'],
          evidence: ['market evidence reference'],
          competitors: [
            {
              competitor: 'Example Competitor Co.',
              positioning: 'premium',
              pricingEvidence: ['competitor pricing reference'],
              source: ['competitor source reference'],
            },
          ],
          products: [
            {
              productIdentity: 'Insulated Jacket X',
              description: 'A warm, waterproof insulated jacket.',
              pricing: { currency: 'EUR', cost: '40', price: '90' },
              source: ['product source reference'],
            },
          ],
        },
      ],
    },
    product: {
      productIdentity: 'Insulated Jacket X',
      demandAssessment: 'High demand assessed from market signals.',
      demandConfidence: 'medium',
      competitionAssessment: 'Moderate competition observed.',
      competitionConfidence: 'low',
      marketFitAssessment: 'Good fit for the target market.',
      marketFitConfidence: 'medium',
      commercialPotentialAssessment: 'Healthy margin potential.',
      commercialPotentialConfidence: 'low',
    },
    listing: {
      productTitle: 'Insulated Hiking Jacket - Waterproof',
      benefits: ['Keeps you warm in cold weather.'],
      evidence: [{ topic: 'Spec sheet', finding: 'Shell fabric is ripstop nylon.', source: ['spec sheet reference'] }],
    },
    social_advertising: {
      entryReference: 'calendar-entry-2026-09-01-instagram',
      date: '2026-09-01',
      platform: 'instagram',
    },
  };
}

(async () => {
  // --- 1. FULL HAPPY PATH: all 8 stages, in order, real data flowing stage-to-stage -

  await testAsync('runGrowthWorkflow completes all 8 stages in the requested order, with no tool reclassified', async () => {
    let calls = 0;
    await withEnvConfigured(() =>
      withMockedFetch(
        async () => {
          calls += 1;
          return ordersResponse([SAMPLE_ORDER_NODE]);
        },
        async () => {
          const stageInputs = buildStageInputs();
          const result = await runGrowthWorkflow(null, stageInputs);

          assert.strictEqual(result.status, 'completed');
          assert.strictEqual(result.plan.length, 8);

          const expectedSequence = [
            ['research', 'global_market_opportunity_analysis', 'global_market_opportunity_analysis'],
            ['product', 'market_product_opportunity_analysis', 'market_product_opportunity_analysis'],
            ['listing', 'listing_content_generation', 'listing_content'],
            ['seo', 'seo_analysis', 'product_seo'],
            ['marketing', 'marketing_analysis', 'retention'],
            ['social_advertising', 'content_calendar_generation', 'content_calendar'],
            ['analytics_optimization', 'analytics_data_retrieval', 'sales'],
            ['analytics_optimization', 'analytics', 'growth_opportunities'],
          ];
          result.plan.forEach((step, i) => {
            const [specialistId, toolId, capabilityId] = expectedSequence[i];
            assert.strictEqual(step.selected_specialist.id, specialistId, `step ${i} specialist`);
            assert.strictEqual(step.inputs.tool_id, toolId, `step ${i} tool`);
            assert.strictEqual(step.inputs.capability_id, capabilityId, `step ${i} capability`);
            assert.strictEqual(step.completion_state, 'complete', `step ${i} completion_state`);
          });

          // Product -> Listing: description arrived from the Product stage's real
          // output (extractProductToListing) - stageInputs.listing never set it.
          assert.ok(!('description' in stageInputs.listing));
          const listingRecord = result.plan[2].outputs.result.specialized_records[0];
          assert.strictEqual(listingRecord.description, 'A warm, waterproof insulated jacket.');
          // This file's own auto-threading: productReference defaults to the Product
          // stage's real product_identity - stageInputs.listing never set it either.
          assert.ok(!('productReference' in stageInputs.listing));
          assert.strictEqual(listingRecord.product_reference, 'Insulated Jacket X');

          // Listing -> SEO: productTitle/description arrived from the Listing stage's
          // real output (the new extractListingToSeo flow) - never caller-supplied
          // for this stage.
          const seoRecord = result.plan[3].outputs.result.specialized_records[0];
          assert.strictEqual(seoRecord.product_title, listingRecord.product_title);
          assert.strictEqual(seoRecord.description, listingRecord.description);

          // Product -> Marketing (retention): productReference arrived automatically.
          const marketingRecord = result.plan[4].outputs.result.specialized_records[0];
          assert.strictEqual(marketingRecord.opportunity_type, 'retention');
          assert.strictEqual(marketingRecord.product_reference, 'Insulated Jacket X');

          // Analytics: the real (mocked) order reached the composed snapshot.
          const salesRecord = result.plan[6].outputs.result.specialized_records[0].sales;
          assert.strictEqual(salesRecord.actual_metrics[0].orderId, 'gid://shopify/Order/1');

          // "All -> Analytics" / Optimization: the Marketing retention record fed the
          // Optimization stage's growth_opportunities capability automatically.
          const optimizationRecord = result.plan[7].outputs.result.specialized_records[0];
          assert.strictEqual(optimizationRecord.product_reference, 'Insulated Jacket X');
          assert.strictEqual(optimizationRecord.opportunity_type, 'retention');

          // Analytics -> Optimization drafts: never auto-ranked, missing judgment
          // fields honestly named, never invented.
          assert.strictEqual(result.growth_opportunity_drafts.length, 1);
          assert.deepStrictEqual(result.growth_opportunity_drafts[0].missing_for_ranking.slice(0, 3), [
            'expectedImpactCategory',
            'expectedImpactMagnitude',
            'actionClassification',
          ]);

          assert.strictEqual(result.business_id, null);
          assert.ok(Array.isArray(result.audit_trail) && result.audit_trail.length > 0);
          assert.ok(Array.isArray(result.usage_ledger) && result.usage_ledger.length > 0);
        }
      )
    );
    assert.strictEqual(calls, 1, 'the external Shopify client should be called exactly once, for the Analytics stage only');
  });

  // --- 2. APPROVAL -> APPROVED: the gated stage never executes before a decision, --
  // --- then resumes and the remaining stage still runs afterward -------------------

  await testAsync('a stage requiring approval pauses the whole workflow before executing, then resumes through to completion once approved', async () => {
    let calls = 0;
    await withEnvConfigured(() =>
      withReclassifiedTool('analytics_data_retrieval', 'externally_executable', () =>
        withMockedFetch(
          async () => {
            calls += 1;
            return ordersResponse([SAMPLE_ORDER_NODE]);
          },
          async () => {
            const stageInputs = buildStageInputs();
            const paused = await runGrowthWorkflow(null, stageInputs);

            assert.strictEqual(paused.status, 'workflow_paused');
            // Stages 0-5 (research..social_advertising) completed; stage 6 (analytics)
            // is the one that got gated - stage 7 (optimization) never ran.
            assert.strictEqual(paused.plan.length, 7);
            assert.strictEqual(paused.plan[6].selected_specialist.id, 'analytics_optimization');
            assert.strictEqual(paused.plan[6].inputs.tool_id, 'analytics_data_retrieval');
            assert.strictEqual(paused.plan[6].completion_state, 'blocked');
            assert.ok(paused.pending_approval);
            assert.strictEqual(paused.pending_approval.status, 'pending');
            assert.strictEqual(paused.pending_approval.tool_id, 'analytics_data_retrieval');
            assert.strictEqual(paused.pending_approval.specialist_id, 'analytics_optimization');
            assert.strictEqual(calls, 0, 'the external client must never be reached before approval');

            const decidedRequests = decideApprovalRequest([paused.pending_approval], paused.pending_approval.id, {
              decision: 'approved',
              decidedBy: 'owner@example.com',
            });
            const resumed = await resumeGrowthWorkflow(decidedRequests[0], paused._resumeState);

            assert.strictEqual(resumed.status, 'completed');
            assert.strictEqual(resumed.plan.length, 8);
            assert.strictEqual(calls, 1, 'the external client must be reached exactly once, only after approval');
            assert.strictEqual(resumed.plan[6].completion_state, 'complete');
            const salesRecord = resumed.plan[6].outputs.result.specialized_records[0].sales;
            assert.strictEqual(salesRecord.actual_metrics[0].orderId, 'gid://shopify/Order/1');
            // The final stage (Optimization) still ran, after resuming.
            assert.strictEqual(resumed.plan[7].selected_specialist.id, 'analytics_optimization');
            assert.strictEqual(resumed.plan[7].inputs.capability_id, 'growth_opportunities');
            assert.strictEqual(resumed.plan[7].completion_state, 'complete');
          }
        )
      )
    );
  });

  // --- 3. APPROVAL -> REJECTED: the gated stage never executes, and the workflow ---
  // --- does not proceed --------------------------------------------------------

  await testAsync('a rejected approval never executes the gated stage, and the workflow does not proceed past it', async () => {
    let calls = 0;
    await withEnvConfigured(() =>
      withReclassifiedTool('analytics_data_retrieval', 'externally_executable', () =>
        withMockedFetch(
          async () => {
            calls += 1;
            throw new Error('the external client must never be called for a rejected request');
          },
          async () => {
            const stageInputs = buildStageInputs();
            const paused = await runGrowthWorkflow(null, stageInputs);

            assert.strictEqual(paused.status, 'workflow_paused');
            assert.strictEqual(paused.plan.length, 7);

            const decidedRequests = decideApprovalRequest([paused.pending_approval], paused.pending_approval.id, {
              decision: 'rejected',
              decidedBy: 'owner@example.com',
              notes: 'Not needed right now.',
            });
            const resumed = await resumeGrowthWorkflow(decidedRequests[0], paused._resumeState);

            assert.strictEqual(resumed.status, 'stopped');
            assert.strictEqual(resumed.plan.length, 7, 'the workflow must not proceed to the final stage after a rejection');
            assert.strictEqual(resumed.plan[6].outputs, null);
            assert.ok(/not approved/.test(resumed.plan[6].errors[0]));
            assert.strictEqual(calls, 0, 'a rejected request must never reach the external client');
          }
        )
      )
    );
  });

  // --- Sanity: the stage key list is exactly the 8 requested stages, in order ------

  await testAsync('STAGE_KEYS names exactly the 8 requested stages, in the requested order', () => {
    assert.deepStrictEqual(STAGE_KEYS, [
      'research',
      'product',
      'listing',
      'seo',
      'marketing',
      'social_advertising',
      'analytics',
      'optimization',
    ]);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();
