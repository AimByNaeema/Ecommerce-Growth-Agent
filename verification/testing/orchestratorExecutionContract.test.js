'use strict';

const assert = require('node:assert');
const path = require('path');
const {
  understandObjective,
  identifyRequiredCapability,
  needsMoreInformation,
  createExecutionRequest,
  selectSpecialist,
  gatherMinimumContext,
  executeSelectedCapability,
  resumeApprovedExecution,
  validateResult,
  splitIntoClauses,
  routeClause,
  planRouting,
  buildRoutingResponse,
  runOrchestratorContract,
  deriveBusinessConfigContext,
} = require('../../agent/core/orchestratorExecutionContract');
const claudeClient = require('../../agent/core/claudeClient');
const { loadEnvOnce: loadShopifyEnvOnce } = require('../../integrations/adapters/shopifyClient');
const { getMaxTokensPerRun } = require('../../agent/core/tokenControls');
const { TOOL_CLASSIFICATIONS } = require('../../agent/core/toolPermissions');
const { decideApprovalRequest } = require('../../approvals/approvalWorkflow');
const { getToolById } = require('../../tools/toolRegistry');
const { getCapabilityTask } = require('../../agent/core/specialistCapabilityRegistry');
const { createAuditTracker } = require('../../audit/auditTrail');
const { createToolResultCache } = require('../../agent/core/toolResultCache');
const { createUsageTracker } = require('../../agent/core/usageLimits');
const { createUsageLedger } = require('../../usage/usageTracker');

function withEnv(name, value, fn) {
  const saved = process.env[name];
  process.env[name] = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    });
}

// This test never makes a real network call - the one real tool it can reach
// (business_configuration_retrieval) fails fast on its own "not configured" check
// before any fetch happens, matching the convention already used in
// shopifyClient.test.js and businessConfigurationRetrieval.test.js. Env vars are
// saved/restored around the cases that depend on them being unset.
//
// The routing test fixtures below were hand-verified against the actual current text
// of agent/core/specialistRegistry.js and tools/toolRegistry.js (word-overlap scores
// computed by hand, not guessed) - see the plan notes for the exact score breakdown.

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

test('understandObjective rejects a non-string task', () => {
  assert.throws(() => understandObjective(42), /non-empty task string/);
});

test('understandObjective rejects an empty/whitespace task', () => {
  assert.throws(() => understandObjective('   '), /non-empty task string/);
});

test('understandObjective trims and collapses whitespace', () => {
  assert.strictEqual(understandObjective('  find   products  '), 'find products');
});

test('identifyRequiredCapability matches a configuration-shaped task', () => {
  const capability = identifyRequiredCapability("check my shop's business configuration");
  assert.ok(capability, 'expected a capability match');
  assert.strictEqual(capability.tool.id, 'business_configuration_retrieval');
  assert.strictEqual(capability.category, 'configuration');
});

test('identifyRequiredCapability matches a products-shaped task', () => {
  const capability = identifyRequiredCapability('run product research on my catalog');
  assert.ok(capability, 'expected a capability match');
  assert.strictEqual(capability.category, 'products');
});

test('identifyRequiredCapability returns null for an unmatchable task', () => {
  assert.strictEqual(identifyRequiredCapability('zzqxvth wobble unicorn'), null);
});

test('needsMoreInformation is true when no capability matched', () => {
  const result = needsMoreInformation('zzqxvth wobble unicorn', null);
  assert.strictEqual(result.needs_more_information, true);
});

test('needsMoreInformation is false when a capability matched', () => {
  const capability = identifyRequiredCapability("check my shop's business configuration");
  const result = needsMoreInformation("check my shop's business configuration", capability);
  assert.strictEqual(result.needs_more_information, false);
  assert.strictEqual(result.reason, null);
});

test('createExecutionRequest routes a configuration-category match to shared infrastructure', () => {
  const capability = identifyRequiredCapability("check my shop's business configuration");
  const request = createExecutionRequest("check my shop's business configuration", capability);
  assert.strictEqual(request.is_shared_infrastructure, true);
  assert.strictEqual(request.specialist_id, null);
});

test('createExecutionRequest routes a products-category match to the product specialist', () => {
  const capability = identifyRequiredCapability('run product research on my catalog');
  const request = createExecutionRequest('run product research on my catalog', capability);
  assert.strictEqual(request.is_shared_infrastructure, false);
  assert.strictEqual(request.specialist_id, 'product');
});

test('selectSpecialist returns shared_infrastructure for a shared-infra request', () => {
  const capability = identifyRequiredCapability("check my shop's business configuration");
  const request = createExecutionRequest("check my shop's business configuration", capability);
  const specialist = selectSpecialist(request);
  assert.strictEqual(specialist.type, 'shared_infrastructure');
});

test('selectSpecialist returns the product specialist, honestly relaying its real status from specialistRegistry.js', () => {
  const capability = identifyRequiredCapability('run product research on my catalog');
  const request = createExecutionRequest('run product research on my catalog', capability);
  const specialist = selectSpecialist(request);
  assert.strictEqual(specialist.type, 'specialist');
  assert.strictEqual(specialist.id, 'product');
  assert.strictEqual(specialist.status, 'implemented');
});

test('gatherMinimumContext returns only the relevant boundary entries, not all six', () => {
  const capability = identifyRequiredCapability("check my shop's business configuration");
  const request = createExecutionRequest("check my shop's business configuration", capability);
  const context = gatherMinimumContext(request);
  const ids = context.map((boundary) => boundary.id);
  assert.ok(ids.includes('tool_context'));
  assert.ok(ids.includes('business_context'));
  assert.ok(!ids.includes('product_context'));
  assert.ok(context.length < 6);
});

test('validateResult marks a well-formed success outcome as passed', () => {
  assert.strictEqual(validateResult({ status: 'success', data: { name: 'x' }, error: null }), 'passed');
});

test('validateResult marks an error outcome as failed', () => {
  assert.strictEqual(validateResult({ status: 'error', data: null, error: 'boom' }), 'failed');
});

test('validateResult marks a not_available outcome as unverified', () => {
  assert.strictEqual(validateResult({ status: 'not_available', data: null, error: 'not built yet' }), 'unverified');
});

test('validateResult marks a malformed outcome as failed', () => {
  assert.strictEqual(validateResult(null), 'failed');
  assert.strictEqual(validateResult({}), 'failed');
});

// --- Structured routing: clause splitting -----------------------------------------

test('splitIntoClauses returns a single clause when there is no separator', () => {
  assert.deepStrictEqual(splitIntoClauses('keyword search visibility'), ['keyword search visibility']);
});

test('splitIntoClauses splits on "and"', () => {
  assert.deepStrictEqual(
    splitIntoClauses('market competitor research and social media advertising'),
    ['market competitor research', 'social media advertising']
  );
});

test('splitIntoClauses does not split inside a word ("brand" is not "and")', () => {
  assert.deepStrictEqual(splitIntoClauses('grow my brand'), ['grow my brand']);
});

// --- Structured routing: routeClause -----------------------------------------------

test('routeClause cleanly matches a single specialist (SEO)', () => {
  const result = routeClause('keyword search visibility');
  assert.strictEqual(result.status, 'matched');
  assert.strictEqual(result.target.type, 'specialist');
  assert.strictEqual(result.target.id, 'seo');
});

test('routeClause can now route to Listing, which has no TOOL_REGISTRY category at all', () => {
  const result = routeClause('improve my listing content');
  assert.strictEqual(result.status, 'matched');
  assert.strictEqual(result.target.id, 'listing');
});

test('routeClause routes to Social & Advertising, which now has a real TOOL_REGISTRY category', () => {
  const result = routeClause('social media advertising');
  assert.strictEqual(result.status, 'matched');
  assert.strictEqual(result.target.id, 'social_advertising');
});

test('routeClause reports ambiguous when two targets tie for the top score', () => {
  const result = routeClause('I need content optimization help');
  assert.strictEqual(result.status, 'ambiguous');
  const ids = result.candidates.map((candidate) => candidate.id).sort();
  assert.deepStrictEqual(ids, ['analytics_optimization', 'listing']);
});

test('routeClause reports unmatched when nothing scores', () => {
  const result = routeClause('flibbertigibbet dance');
  assert.strictEqual(result.status, 'unmatched');
});

// Regression: "Analyze my ecommerce business" used to silently win the "configuration"
// shared-infrastructure target (a tool that only fetches the shop's name/domain/email)
// purely because the word "business" happens to appear in that tool's own title -
// every real specialist scored 0, so nothing was even ambiguous, it just silently
// misrouted. ROUTING_SYNONYMS teaches analytics_optimization's routing text this
// common phrasing (its own description already covers "analyzing the business" -
// "Store performance, growth metrics, and optimization recommendations") without
// touching agent/core/specialistRegistry.js's real title/description anywhere.
test('routeClause routes a generic "analyze my business" phrasing to Analytics & Optimization, not the configuration shared-infrastructure tool', () => {
  const result = routeClause('Analyze my ecommerce business');
  assert.strictEqual(result.status, 'matched');
  assert.strictEqual(result.target.type, 'specialist');
  assert.strictEqual(result.target.id, 'analytics_optimization');
});

test('routeClause still matches Analytics & Optimization on its own real, undisturbed vocabulary', () => {
  const result = routeClause('store performance and growth metrics');
  assert.strictEqual(result.status, 'matched');
  assert.strictEqual(result.target.id, 'analytics_optimization');
});

// Regression: generic/incidental word overlap must not let a shared-infrastructure
// tool win or tie against a real specialist for a goal-oriented request. Before the
// GOAL/GENERIC word weighting + specialist-preferred tie-break, this exact request
// tied "product" (word "opportunity") against the "configuration" shared-infrastructure
// target (word "shopify", which only appears there because
// tools/businessConfigurationRetrieval.js's description mentions "the connected
// Shopify store") and was reported ambiguous instead of routing to Product.
test('routeClause routes "biggest opportunity to increase Shopify sales" to Product, not the configuration shared-infrastructure tool', () => {
  const result = routeClause('Identify the single biggest opportunity to increase my Shopify sales.');
  assert.strictEqual(result.status, 'matched');
  assert.strictEqual(result.target.type, 'specialist');
  assert.strictEqual(result.target.id, 'product');
});

test('routeClause routes "biggest SEO opportunity" to SEO, not Product', () => {
  const result = routeClause('What is my biggest SEO opportunity?');
  assert.strictEqual(result.status, 'matched');
  assert.strictEqual(result.target.id, 'seo');
});

test('routeClause routes "strongest growth opportunity" for a product to Product', () => {
  const result = routeClause('Which product has the strongest growth opportunity?');
  assert.strictEqual(result.status, 'matched');
  assert.strictEqual(result.target.id, 'product');
});

test('routeClause routes "best low-cost marketing opportunity" to Marketing', () => {
  const result = routeClause('What is the best low-cost marketing opportunity?');
  assert.strictEqual(result.status, 'matched');
  assert.strictEqual(result.target.id, 'marketing');
});

// Regression: the full multi-clause example from the bug report. "Analyze my ecommerce
// business" (-> analytics_optimization) and "identify the single biggest opportunity to
// increase sales" (-> product) are two clauses split on "and" - neither may resolve to
// the "configuration" shared-infrastructure target.
test('planRouting plans "analyze my business and identify the biggest sales opportunity" to Product + Analytics & Optimization, never configuration', () => {
  const result = planRouting(
    'Analyze my ecommerce business and identify the single biggest opportunity to increase sales.'
  );
  assert.strictEqual(result.status, 'planned');
  const ids = result.targets.map((target) => target.id).sort();
  assert.deepStrictEqual(ids, ['analytics_optimization', 'product']);
  assert.ok(!result.targets.some((target) => target.type === 'shared_infrastructure'));
});

// PHASE 1 REGRESSION (real-world testing): plural phrasing a business owner naturally
// types used to score 0 everywhere (no stemming in tokenize()) and fell through to
// "unmatched" instead of routing at all. See ROUTING_SYNONYMS's own comment above for
// the full investigation.
test('routeClause routes "what keywords should we target" (plural) to SEO', () => {
  const result = routeClause('What keywords should we target for our SVG bundle?');
  assert.strictEqual(result.status, 'matched');
  assert.strictEqual(result.target.type, 'specialist');
  assert.strictEqual(result.target.id, 'seo');
});

test('routeClause routes "improve our bundle listings" (plural) to Listing', () => {
  const result = routeClause('Improve our bundle listings.');
  assert.strictEqual(result.status, 'matched');
  assert.strictEqual(result.target.type, 'specialist');
  assert.strictEqual(result.target.id, 'listing');
});

test('routeClause routes "how many orders have we had recently" to Analytics & Optimization', () => {
  const result = routeClause('How many orders have we had recently?');
  assert.strictEqual(result.status, 'matched');
  assert.strictEqual(result.target.type, 'specialist');
  assert.strictEqual(result.target.id, 'analytics_optimization');
});

// PHASE 1 REGRESSION (real-world testing): "Write new titles for our existing product
// listings." used to score Product 6 vs Listing 3 - the generic noun "product"
// (weighted as a GOAL_ROUTING_WORD, x2) appears 3x in Product's own
// id/title/description by construction, so it single-handedly outscored Listing's real
// intent signal. "product" was reclassified into GENERIC_ROUTING_WORDS (weight 0.5,
// the same bucket as "business" - see that set's own comment) and 'titles' was added
// to Listing's routing vocabulary. See ROUTING_SYNONYMS's own comment above for the
// full investigation and the confirmed scoring math (Listing 2.5 vs Product 1.5).
test('routeClause routes "write new titles for our existing product listings" to Listing, not Product', () => {
  const result = routeClause('Write new titles for our existing product listings.');
  assert.strictEqual(result.status, 'matched');
  assert.strictEqual(result.target.type, 'specialist');
  assert.strictEqual(result.target.id, 'listing');
});

test('routeClause still routes a genuine Product objective ("what products do we currently have in our Shopify store") to Product after the "product" reweighting', () => {
  const result = routeClause('What products do we currently have in our Shopify store?');
  assert.strictEqual(result.status, 'matched');
  assert.strictEqual(result.target.type, 'specialist');
  assert.strictEqual(result.target.id, 'product');
});

// --- Structured routing: planRouting -----------------------------------------------

test('planRouting produces a single-target plan for a single-capability task', () => {
  const result = planRouting('keyword search visibility');
  assert.strictEqual(result.status, 'planned');
  assert.strictEqual(result.targets.length, 1);
  assert.strictEqual(result.targets[0].id, 'seo');
});

test('planRouting produces a controlled multi-step plan for a multi-capability task', () => {
  const result = planRouting('market competitor research and social media advertising');
  assert.strictEqual(result.status, 'planned');
  assert.strictEqual(result.targets.length, 2);
  const ids = result.targets.map((target) => target.id);
  assert.deepStrictEqual(ids, ['research', 'social_advertising']);
});

test('planRouting dedupes repeated matches to the same target into one plan step', () => {
  const result = planRouting('market research and more market research');
  assert.strictEqual(result.status, 'planned');
  assert.strictEqual(result.targets.length, 1);
  assert.strictEqual(result.targets[0].id, 'research');
});

test('planRouting requires clarification for an ambiguous request instead of guessing', () => {
  const result = planRouting('I need content optimization help');
  assert.strictEqual(result.status, 'clarification_required');
  assert.strictEqual(result.clarification_type, 'ambiguous');
  assert.ok(result.candidates.length >= 2);
});

test('planRouting requires clarification when part of a multi-clause request is unmatched', () => {
  const result = planRouting('research my market and do the flibbertigibbet dance');
  assert.strictEqual(result.status, 'clarification_required');
  assert.strictEqual(result.clarification_type, 'unmatched');
  assert.ok(/flibbertigibbet/.test(result.unmatched_segment));
});

test('planRouting requires clarification for a fully unmatched task', () => {
  const result = planRouting('zzqxvth wobble unicorn');
  assert.strictEqual(result.status, 'clarification_required');
  assert.strictEqual(result.clarification_type, 'unmatched');
});

(async () => {
  await testAsync('executeSelectedCapability returns not_available for an unimplemented tool', async () => {
    const capability = identifyRequiredCapability('run product research on my catalog');
    const request = createExecutionRequest('run product research on my catalog', capability);
    const outcome = await executeSelectedCapability(request);
    assert.strictEqual(outcome.status, 'not_available');
    assert.ok(outcome.error.includes('not yet implemented'));
  });

  await testAsync('executeSelectedCapability surfaces the clear not-configured error for business_configuration_retrieval, without crashing', async () => {
    // Force shopifyClient.js's one-time .env load to happen before the delete below -
    // otherwise, if this is the first call into shopifyClient.js in this process, the
    // not-configured check would reload real Shopify credentials from the local .env
    // file right after the delete and attempt a live network call instead of
    // rejecting (see verification/testing/businessConfigurationRetrieval.test.js's
    // identical fix).
    loadShopifyEnvOnce();
    const savedDomain = process.env.SHOPIFY_STORE_DOMAIN;
    const savedToken = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    delete process.env.SHOPIFY_STORE_DOMAIN;
    delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    try {
      const capability = identifyRequiredCapability("check my shop's business configuration");
      const request = createExecutionRequest("check my shop's business configuration", capability);
      const outcome = await executeSelectedCapability(request);
      assert.strictEqual(outcome.status, 'error');
      assert.ok(/SHOPIFY_STORE_DOMAIN/.test(outcome.error));
    } finally {
      if (savedDomain === undefined) delete process.env.SHOPIFY_STORE_DOMAIN;
      else process.env.SHOPIFY_STORE_DOMAIN = savedDomain;
      if (savedToken === undefined) delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
      else process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = savedToken;
    }
  });

  await testAsync('runOrchestratorContract: an empty task requires clarification and never throws', async () => {
    const response = await runOrchestratorContract('');
    assert.strictEqual(response.needs_more_information, true);
    assert.strictEqual(response.routing.status, 'clarification_required');
    assert.strictEqual(response.routing.plan, null);
  });

  await testAsync('runOrchestratorContract: a clean single-specialist task (SEO) produces a one-step plan of shared execution state', async () => {
    const response = await runOrchestratorContract('keyword search visibility');
    assert.strictEqual(response.needs_more_information, false);
    assert.strictEqual(response.routing.status, 'planned');
    assert.strictEqual(response.routing.plan.length, 1);
    const step = response.routing.plan[0];
    assert.strictEqual(step.request, 'keyword search visibility');
    assert.strictEqual(step.current_task, 'keyword search visibility');
    assert.strictEqual(step.selected_specialist.id, 'seo');
    assert.deepStrictEqual(step.tool_calls, ['keyword_research']);
    // keyword_research's own required field (keywords) has no approved live source and
    // no evidence was supplied - the orchestrator now stops BEFORE dispatching the tool
    // (see buildPlanStep's requiredEvidenceMissing check) rather than calling it just to
    // receive its own honest 'failed' status back. completion_state is 'blocked' (an
    // outcome exists - the clarification - but it is neither passed nor failed), never
    // 'complete', and outputs stays null since nothing was ever dispatched.
    assert.strictEqual(step.completion_state, 'blocked');
    assert.strictEqual(step.outputs, null);
    assert.ok(step.errors[0].includes('keywords'));
  });

  await testAsync('runOrchestratorContract: a clean single-specialist task (Listing) produces a one-step plan of shared execution state', async () => {
    const response = await runOrchestratorContract('improve my listing content');
    assert.strictEqual(response.needs_more_information, false);
    assert.strictEqual(response.routing.status, 'planned');
    assert.strictEqual(response.routing.plan.length, 1);
    const step = response.routing.plan[0];
    assert.strictEqual(step.selected_specialist.id, 'listing');
    assert.deepStrictEqual(step.tool_calls, ['listing_content_generation']);
    // listing_content's required field (productReference) has no approved live source
    // and no evidence was supplied (no earlier Product step ran in this single-step
    // plan) - stopped before dispatch, same as the SEO case above.
    assert.strictEqual(step.completion_state, 'blocked');
    assert.strictEqual(step.outputs, null);
    assert.ok(step.errors[0].includes('productReference'));
  });

  await testAsync(
    'runOrchestratorContract: a Listing request that ties between listing_content and marketplace_format ' +
      'stops for clarification instead of silently picking the first-declared capability',
    async () => {
      // "identify my top listing opportunity" routes to the Listing specialist (stage 1)
      // but scores an exact tie between listing_content and marketplace_format (stage 2:
      // bestMatchingTask) - neither task's own id/title/description text is a real,
      // distinguishing match for this wording. Before the ambiguousCapabilityTasks fix,
      // this silently picked listing_content (first declared in LISTING_TASKS) and
      // reported a misleading "needs productReference" error, as if that specific
      // capability had genuinely been the intended one.
      const response = await runOrchestratorContract('identify my top listing opportunity');
      assert.strictEqual(response.needs_more_information, false);
      assert.strictEqual(response.routing.status, 'planned');
      assert.strictEqual(response.routing.plan.length, 1);
      const step = response.routing.plan[0];
      assert.strictEqual(step.selected_specialist.id, 'listing');
      assert.strictEqual(step.completion_state, 'blocked');
      assert.strictEqual(step.outputs, null);
      assert.ok(step.errors[0].includes('Listing content generation'));
      assert.ok(step.errors[0].includes('Marketplace format'));
      assert.ok(!step.errors[0].includes('productReference'));
    }
  );

  await testAsync(
    'runOrchestratorContract: the Listing capability-tie clarification fires even when the caller already ' +
      'supplied every required field, proving it is a real ambiguity stop, not a disguised missing-evidence stop',
    async () => {
      const response = await runOrchestratorContract('identify my top listing opportunity', {
        researchParams: { productReference: 'Example insulated jacket', marketplace: 'Etsy' },
      });
      assert.strictEqual(response.routing.status, 'planned');
      const step = response.routing.plan[0];
      assert.strictEqual(step.selected_specialist.id, 'listing');
      assert.strictEqual(step.completion_state, 'blocked');
      assert.ok(/Could not confidently tell which/.test(step.errors[0]));
    }
  );

  await testAsync(
    'runOrchestratorContract: a Listing request that clearly favors marketplace_format still selects it ' +
      'correctly - the tie/ambiguity fix does not break a real, single-winner capability match',
    async () => {
      const response = await runOrchestratorContract('reformat my listing content for the Etsy marketplace');
      assert.strictEqual(response.routing.status, 'planned');
      assert.strictEqual(response.routing.plan.length, 1);
      const step = response.routing.plan[0];
      assert.strictEqual(step.selected_specialist.id, 'listing');
      assert.deepStrictEqual(step.tool_calls, ['listing_content_generation']);
      assert.strictEqual(step.completion_state, 'blocked');
      // Correctly resolved to marketplace_format (not an ambiguity stop) - its own
      // required fields (marketplace, productReference) are simply unmet here.
      assert.ok(step.errors[0].includes('Marketplace format'));
      assert.ok(step.errors[0].includes('marketplace'));
      assert.ok(step.errors[0].includes('productReference'));
    }
  );

  await testAsync('runOrchestratorContract: a clean single-specialist task (Marketing) produces a one-step plan of shared execution state', async () => {
    const response = await runOrchestratorContract('marketing campaign strategy');
    assert.strictEqual(response.needs_more_information, false);
    assert.strictEqual(response.routing.status, 'planned');
    assert.strictEqual(response.routing.plan.length, 1);
    const step = response.routing.plan[0];
    assert.strictEqual(step.selected_specialist.id, 'marketing');
    assert.deepStrictEqual(step.tool_calls, ['marketing_analysis']);
    // marketing_strategy's required field (marketingChannel) has no approved live
    // source and no evidence was supplied - stopped before dispatch, same as above.
    assert.strictEqual(step.completion_state, 'blocked');
    assert.strictEqual(step.outputs, null);
    assert.ok(step.errors[0].includes('marketingChannel'));
  });

  await testAsync('runOrchestratorContract: a general "best marketing opportunity" objective routes to marketing_opportunity_ranking, not marketing_strategy', async () => {
    // Regression coverage for the routing bug this capability fixes: this exact
    // objective used to select marketing_strategy and block on the misleading
    // marketingChannel error (see the failing-request investigation this capability
    // was built from).
    const response = await runOrchestratorContract(
      'Identify the single best marketing opportunity to increase sales for my ecommerce business.'
    );
    assert.strictEqual(response.routing.plan.length, 1);
    const step = response.routing.plan[0];
    assert.strictEqual(step.selected_specialist.id, 'marketing');
    assert.strictEqual(step.inputs.capability_id, 'marketing_opportunity_ranking');
    // Insufficient-evidence behavior: a bare free-text objective with no candidates
    // honestly stops before dispatch - it never guesses a "best" opportunity.
    assert.strictEqual(step.completion_state, 'blocked');
    assert.strictEqual(step.outputs, null);
    assert.ok(step.errors[0].includes('candidates'));
    assert.ok(!step.errors[0].includes('marketingChannel'));
  });

  await testAsync('runOrchestratorContract: the same objective with real candidates supplied ranks them for real, never inventing a winner', async () => {
    const response = await runOrchestratorContract(
      'Identify the single best marketing opportunity to increase sales for my ecommerce business.',
      {
        researchParams: {
          candidates: [
            {
              opportunity: 'Launch Pinterest Ads for the insulated jacket line',
              reason: 'Pinterest organic pins already drive traffic.',
              evidence: ['(placeholder pinterest analytics report)'],
              expectedImpactCategory: 'revenue',
              expectedImpactMagnitude: 4,
              requiredAction: 'Set up a Pinterest Ads campaign.',
              actionClassification: 'externally_executable',
            },
            {
              opportunity: 'Send a TikTok influencer package',
              reason: 'TikTok shows craft/design use cases.',
              expectedImpactCategory: 'traffic_visibility',
              expectedImpactMagnitude: 2,
              requiredAction: 'Reach out to 3 relevant creators.',
              actionClassification: 'recommendation',
            },
          ],
        },
      }
    );
    const step = response.routing.plan[0];
    assert.strictEqual(step.inputs.capability_id, 'marketing_opportunity_ranking');
    assert.strictEqual(step.outputs.status, 'partial');
    const records = step.outputs.result.specialized_records;
    assert.strictEqual(records[0].opportunity, 'Launch Pinterest Ads for the insulated jacket line');
    assert.strictEqual(records[0].rank, 1);
    assert.strictEqual(records[1].rank, 2);
  });

  await testAsync('runOrchestratorContract: existing channel-specific Marketing capabilities are unaffected by marketing_opportunity_ranking', async () => {
    // Same objective as the original single-specialist Marketing test above - proves
    // adding marketing_opportunity_ranking did not shift routing for a genuinely
    // channel-oriented request.
    const response = await runOrchestratorContract('marketing campaign strategy');
    const step = response.routing.plan[0];
    assert.strictEqual(step.inputs.capability_id, 'marketing_strategy');
    assert.ok(step.errors[0].includes('marketingChannel'));
  });

  await testAsync('runOrchestratorContract: a multi-capability task produces a controlled 2-step plan, each step self-contained', async () => {
    const response = await runOrchestratorContract('market competitor research and social media advertising');
    assert.strictEqual(response.routing.status, 'planned');
    assert.strictEqual(response.routing.plan.length, 2);
    const [researchStep, socialStep] = response.routing.plan;
    assert.strictEqual(researchStep.selected_specialist.id, 'research');
    assert.strictEqual(researchStep.current_task, 'market competitor research');
    assert.strictEqual(socialStep.selected_specialist.id, 'social_advertising');
    assert.strictEqual(socialStep.current_task, 'social media advertising');
    // Neither step's state carries the other specialist's tool_calls/outputs - each is
    // independently minimal (the whole point of the shared execution state design).
    // social_content_planning is implemented and now scores highest against this
    // clause's own wording ("social", "media"); its matched capability's required
    // field (contentReference) has no approved live source and no evidence was
    // supplied - stopped before dispatch, same as the single-specialist cases above.
    assert.deepStrictEqual(socialStep.tool_calls, ['social_content_planning']);
    assert.strictEqual(socialStep.completion_state, 'blocked');
    assert.strictEqual(socialStep.outputs, null);
    assert.ok(socialStep.errors[0].includes('contentReference'));
    assert.strictEqual(researchStep.selected_specialist.id !== socialStep.selected_specialist.id, true);
  });

  // --- Specialist capability registry connection ---------------------------------
  //
  // agent/core/specialistCapabilityRegistry.js is now the source for which tools a
  // specialist may use (required_tools) and, once a tool is matched, which declared
  // capability/task it actually serves (inputs.capability_id/input_contract) - see
  // buildPlanStep's header comment. These fixtures were observed by running the real
  // orchestrator (not hand-predicted), the same practice this file's own header notes
  // for the word-overlap routing fixtures above.

  await testAsync('runOrchestratorContract: SEO plan step names the exact matched capability and its real input contract', async () => {
    const response = await runOrchestratorContract('keyword search visibility');
    const step = response.routing.plan[0];
    assert.strictEqual(step.inputs.tool_id, 'keyword_research');
    assert.strictEqual(step.inputs.capability_id, 'keyword_research');
    // Reuses the registry's own real input_contract rather than a hardcoded literal,
    // so this assertion never drifts from agent/core/specialistCapabilityRegistry.js.
    assert.deepStrictEqual(
      step.inputs.input_contract,
      getCapabilityTask('seo', 'keyword_research').input_contract
    );
    assert.ok(step.inputs.input_contract.required.includes('keywords'));
    assert.ok(step.inputs.input_contract.optional.length > 0, 'keyword_research should now declare optional fields');
  });

  await testAsync('runOrchestratorContract: a matched tool with zero connected capabilities (Product) honestly reports capability_id null, never guessed', async () => {
    // Wording updated for the "product" GENERIC_ROUTING_WORDS reclassification above:
    // the original phrasing ("run product research on my catalog") also contained
    // "research", which - now that "product" no longer outscores it - legitimately
    // routes to the Research specialist instead (Research's own id/title/description
    // repeats "research" 3x, same structural pattern "product" had). Dropping
    // "research" keeps this test's real target (Product's own product_research tool,
    // which has zero connected capabilities) unambiguous without it.
    const response = await runOrchestratorContract('Run product catalog pipeline.');
    const step = response.routing.plan[0];
    assert.strictEqual(step.selected_specialist.id, 'product');
    assert.strictEqual(step.inputs.tool_id, 'product_research');
    assert.strictEqual(step.inputs.capability_id, null);
    assert.strictEqual(step.inputs.input_contract, null);
  });

  await testAsync('runOrchestratorContract: a shared-infrastructure step (no specialist, no capability registry entry) reports capability_id null', async () => {
    const response = await runOrchestratorContract("check my shop's business configuration");
    const step = response.routing.plan[0];
    assert.strictEqual(step.selected_specialist.type, 'shared_infrastructure');
    assert.strictEqual(step.inputs.capability_id, null);
  });

  await testAsync('runOrchestratorContract: a multi-step plan resolves each step\'s capability independently, one tool -> one specialist only', async () => {
    const response = await runOrchestratorContract('market competitor research and social media advertising');
    const [researchStep, socialStep] = response.routing.plan;
    assert.strictEqual(researchStep.inputs.tool_id, 'market_research');
    assert.strictEqual(researchStep.inputs.capability_id, 'market_research');
    assert.strictEqual(socialStep.inputs.tool_id, 'social_content_planning');
    // 5 platform capabilities (instagram/facebook/tiktok/.../youtube) share this one
    // tool and none of their names appear in the clause's own wording, so they tie -
    // the documented, deterministic tie-break (declared order, first wins) resolves
    // it to 'instagram' rather than guessing among equally-scored candidates.
    assert.strictEqual(socialStep.inputs.capability_id, 'instagram');
  });

  // --- Structured cross-agent context passing: genuine end-to-end multi-step runs --
  //
  // Each fixture's objective wording and researchParams were empirically verified by
  // running the real orchestrator (not hand-predicted) - same practice as the
  // capability-registry connection tests above. These exercise the full real pipeline
  // for the 3 declared flows whose both ends are tool-reachable today (SEO/Listing,
  // Marketing/Social & Advertising, and the growth-opportunity flows through
  // Analytics) - see agent/core/crossAgentContext.js's own unit tests
  // (verification/testing/crossAgentContext.test.js) for the other 2 declared flows
  // (Research -> Product, Product -> Listing/Marketing), which are correct and fully
  // wired but not yet live-reachable: agent/core/productAgent.js has no tool wired to
  // it in tools/toolRegistry.js today (a pre-existing, separately-scoped gap - see
  // specialistCapabilityRegistry's own honest tool_ids: [] for every Product task).

  await testAsync('SEO -> Listing: a real product_seo result feeds listing_content\'s seoRecommendations for real, in one plan', async () => {
    // "refresh my listing benefits" (not just "refresh my listing") - since the
    // Listing-only ambiguity guard added in buildPlanStep (isAmbiguousCapabilityMatch)
    // now correctly refuses to declared-order-guess between listing_content and
    // marketplace_format on a bare tie, this clause needs one real, distinguishing
    // word only listing_content's own task text contains ("benefits") to resolve
    // deterministically to listing_content, exactly as this test still intends.
    const response = await runOrchestratorContract('seo analysis and refresh my listing benefits', {
      researchParams: {
        productReference: 'Insulated Hiking Jacket',
        productTitle: 'Insulated Hiking Jacket',
        description: 'Warm and sustainable.',
        keywords: ['insulated jacket', 'hiking gear'],
      },
    });
    const [seoStep, listingStep] = response.routing.plan;
    assert.strictEqual(seoStep.selected_specialist.id, 'seo');
    assert.strictEqual(seoStep.inputs.capability_id, 'product_seo');
    assert.strictEqual(listingStep.selected_specialist.id, 'listing');
    assert.strictEqual(listingStep.inputs.capability_id, 'listing_content');
    const listingRecord = listingStep.outputs.result.specialized_records[0];
    assert.strictEqual(listingRecord.product_title, 'Insulated Hiking Jacket');
    assert.deepStrictEqual(listingStep.outputs.result.findings, [
      'SEO-recommended keyword: insulated jacket',
      'SEO-recommended keyword: hiking gear',
    ]);
  });

  await testAsync('Marketing -> Social & Advertising: a real campaign_planning result feeds content_calendar\'s campaignContext for real, in one plan', async () => {
    const response = await runOrchestratorContract('plan my campaign and schedule a social calendar entry', {
      researchParams: {
        campaignReference: 'Winter Launch',
        objective: 'Drive awareness',
        audience: 'Hikers',
        entryReference: 'Nov-15-Post',
        date: '2026-11-15',
        platform: 'instagram',
      },
    });
    const [marketingStep, socialStep] = response.routing.plan;
    assert.strictEqual(marketingStep.selected_specialist.id, 'marketing');
    assert.strictEqual(marketingStep.inputs.capability_id, 'campaign_planning');
    assert.strictEqual(socialStep.selected_specialist.id, 'social_advertising');
    assert.strictEqual(socialStep.inputs.capability_id, 'content_calendar');
    const calendarEntry = socialStep.outputs.result.specialized_records[0];
    assert.strictEqual(calendarEntry.campaign, 'Winter Launch');
  });

  await testAsync('All -> Analytics + Analytics -> Optimization: a real Marketing retention result feeds Analytics\' growth_opportunities and the growth_opportunity_drafts response field, in one plan', async () => {
    const response = await runOrchestratorContract('launch a retention campaign and surface growth opportunities for optimization', {
      researchParams: {
        productReference: 'Insulated Jacket',
        targetSegment: 'Lapsed customers',
        offer: 'Win-back 15% off',
        recommendation: 'Send a win-back email.',
        evidence: ['(placeholder evidence)'],
      },
    });
    const [marketingStep, analyticsStep] = response.routing.plan;
    assert.strictEqual(marketingStep.inputs.capability_id, 'retention');
    assert.strictEqual(analyticsStep.selected_specialist.id, 'analytics_optimization');
    assert.strictEqual(analyticsStep.inputs.capability_id, 'growth_opportunities');
    assert.strictEqual(analyticsStep.outputs.status, 'success');
    // "All -> Analytics": the real opportunity Marketing produced is what Analytics
    // actually scored - not a fabricated one.
    assert.strictEqual(analyticsStep.outputs.result.specialized_records[0].product_reference, 'Insulated Jacket');

    // "Analytics -> Optimization": one draft candidate for
    // agent/core/growthOpportunityEngine.js, deduped (the same real record reached
    // both Marketing's and Analytics' output) - real fields relayed, judgment fields
    // honestly named as missing, never invented.
    assert.strictEqual(response.growth_opportunity_drafts.length, 1);
    const [draft] = response.growth_opportunity_drafts;
    assert.strictEqual(draft.category, 'retention');
    assert.strictEqual(draft.requiredAction, 'Send a win-back email.');
    assert.deepStrictEqual(draft.missing_for_ranking, ['expectedImpactCategory', 'expectedImpactMagnitude', 'actionClassification']);
  });

  await testAsync('growth_opportunity_drafts is null for a clarification-required response (no plan ran)', async () => {
    const response = await runOrchestratorContract('zzqxvth wobble unicorn');
    assert.strictEqual(response.growth_opportunity_drafts, null);
  });

  await testAsync('growth_opportunity_drafts is an empty array (not null) for a plan that produced no growth-opportunity-shaped output', async () => {
    const response = await runOrchestratorContract('keyword search visibility');
    assert.deepStrictEqual(response.growth_opportunity_drafts, []);
  });

  await testAsync('runOrchestratorContract: an ambiguous task requires clarification instead of assuming', async () => {
    const response = await runOrchestratorContract('I need content optimization help');
    assert.strictEqual(response.needs_more_information, true);
    assert.strictEqual(response.routing.clarification_type, 'ambiguous');
    assert.strictEqual(response.routing.plan, null);
    const ids = response.routing.candidates.map((candidate) => candidate.id).sort();
    assert.deepStrictEqual(ids, ['analytics_optimization', 'listing']);
  });

  await testAsync('runOrchestratorContract: a partially-matched multi-clause task requires clarification', async () => {
    const response = await runOrchestratorContract('research my market and do the flibbertigibbet dance');
    assert.strictEqual(response.needs_more_information, true);
    assert.strictEqual(response.routing.clarification_type, 'unmatched');
    assert.ok(/flibbertigibbet/.test(response.routing.unmatched_segment));
  });

  await testAsync('runOrchestratorContract: a configuration-domain task still attempts the real tool and reports its result cleanly', async () => {
    const savedDomain = process.env.SHOPIFY_STORE_DOMAIN;
    const savedToken = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    delete process.env.SHOPIFY_STORE_DOMAIN;
    delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    try {
      const response = await runOrchestratorContract("check my shop's business configuration");
      assert.strictEqual(response.routing.status, 'planned');
      assert.strictEqual(response.routing.plan.length, 1);
      const step = response.routing.plan[0];
      assert.strictEqual(step.selected_specialist.type, 'shared_infrastructure');
      assert.strictEqual(step.completion_state, 'failed');
      assert.ok(/SHOPIFY_STORE_DOMAIN/.test(step.errors[0]));
      assert.strictEqual(response.verification_status, 'failed');
      assert.strictEqual(response.state.task_status, 'failed');
    } finally {
      if (savedDomain === undefined) delete process.env.SHOPIFY_STORE_DOMAIN;
      else process.env.SHOPIFY_STORE_DOMAIN = savedDomain;
      if (savedToken === undefined) delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
      else process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = savedToken;
    }
  });

  // --- Claude connection: integration-level, through the real orchestrator dispatch ---
  //
  // aiReasoningCompletion.js calls claudeClient.sendMessage via the required module
  // object (not a destructured binding), so it can be mocked here the same way
  // verification/testing/aiReasoningCompletion.test.js does - see that file's header.

  await testAsync('ALLOWED (mocked): a Claude-routed task runs end-to-end through the real orchestrator, gated by the same permission/approval/state pipeline as every other tool', async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-not-real';
    const originalSendMessage = claudeClient.sendMessage;
    claudeClient.sendMessage = async () => ({
      text: 'Mocked marketing blurb.',
      model: 'claude-sonnet-5',
      stopReason: 'end_turn',
      usage: { input_tokens: 20, output_tokens: 10 },
      raw: {},
    });

    try {
      const response = await runOrchestratorContract('run a claude reasoning completion');
      assert.strictEqual(response.routing.status, 'planned');
      assert.strictEqual(response.routing.plan.length, 1);
      const step = response.routing.plan[0];
      assert.strictEqual(step.selected_specialist.type, 'shared_infrastructure');
      assert.strictEqual(step.selected_specialist.id, 'ai_reasoning');
      assert.deepStrictEqual(step.tool_calls, ['ai_reasoning_completion']);
      assert.strictEqual(step.completion_state, 'complete');
      // A 'recommendation' outcome never reports 'high' confidence, even on success -
      // it's a generated draft, not independently verified data (executionState.js).
      assert.strictEqual(step.confidence, 'unassessed');
      assert.deepStrictEqual(step.approvals, [{ classification: 'recommendation', status: 'auto_approved' }]);
      assert.strictEqual(step.outputs.text, 'Mocked marketing blurb.');
      // Token controls stayed connected: usage from the mocked response was tracked
      // and surfaced on the final response, not silently dropped.
      assert.strictEqual(response.tokens_used, 30);
      // usage/usageTracker.js's structured model_call event carries the input/output
      // split and the model id, not just the collapsed tokens_used integer.
      const modelCallEvent = response.usage_ledger.find((event) => event.category === 'model_call');
      assert.ok(modelCallEvent, 'expected a model_call usage event');
      assert.deepStrictEqual(modelCallEvent.tokens, { input: 20, output: 10, total: 30 });
      assert.strictEqual(modelCallEvent.model, 'claude-sonnet-5');
      assert.strictEqual(modelCallEvent.is_external_api, true);
    } finally {
      claudeClient.sendMessage = originalSendMessage;
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });

  await testAsync('DENIED: the real orchestrator dispatch refuses a Claude call on behalf of a specialist that does not own it, even with a mocked client ready to respond', async () => {
    const originalSendMessage = claudeClient.sendMessage;
    claudeClient.sendMessage = async () => {
      throw new Error('sendMessage should never be reached for a denied request');
    };
    try {
      const executionRequest = {
        objective: 'draft some marketing copy',
        category: 'ai_reasoning',
        tool_id: 'ai_reasoning_completion',
        specialist_id: 'marketing',
        is_shared_infrastructure: false,
      };
      const outcome = await executeSelectedCapability(executionRequest);
      assert.strictEqual(outcome.status, 'denied');
      assert.ok(/not permitted/.test(outcome.error));
    } finally {
      claudeClient.sendMessage = originalSendMessage;
    }
  });

  await testAsync('TOKEN CONTROLS: the real orchestrator dispatch refuses a Claude call once this run\'s token budget is exhausted, and never reaches the mocked client', async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-not-real';
    const originalSendMessage = claudeClient.sendMessage;
    claudeClient.sendMessage = async () => {
      throw new Error('sendMessage should never be reached once the run budget is exhausted');
    };
    try {
      const executionRequest = {
        objective: 'draft some marketing copy',
        category: 'ai_reasoning',
        tool_id: 'ai_reasoning_completion',
        specialist_id: null,
        is_shared_infrastructure: true,
      };
      const exhaustedTracker = { tokensUsedThisRun: getMaxTokensPerRun() };
      const outcome = await executeSelectedCapability(executionRequest, exhaustedTracker);
      assert.strictEqual(outcome.status, 'error');
      assert.ok(/budget/.test(outcome.error));
    } finally {
      claudeClient.sendMessage = originalSendMessage;
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });

  // --- LIVE WEB COMPETITOR RESEARCH: the Research specialist's live counterpart to
  // competitor_research for a free-text objective with no supplied competitors - see
  // agent/core/specialistCapabilityRegistry.js's competitor_research task and
  // buildPlanStep's "LIVE WEB COMPETITOR RESEARCH" block. claudeClient.sendMessage is
  // mocked exactly like the ai_reasoning_completion tests just above.

  await testAsync('MOCKED: an objective that resolves to competitor_research with no researchParams dispatches live_competitor_research instead, and returns a real, verified result', async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-not-real';
    const originalSendMessage = claudeClient.sendMessage;
    const replyJson = {
      topic: 'Top competitor',
      competitors: [
        {
          competitor: 'Acme Candles',
          market: 'United States',
          strengths: ['strong Instagram following'],
          source: ['https://real-search-result.example/acme-candles'],
        },
      ],
      recommendations: ['Undercut their subscription gap.'],
    };
    claudeClient.sendMessage = async () => ({
      text: JSON.stringify(replyJson),
      model: 'claude-sonnet-5',
      stopReason: 'end_turn',
      usage: { input_tokens: 50, output_tokens: 60 },
      raw: {
        content: [
          {
            type: 'web_search_tool_result',
            tool_use_id: 'srvtoolu_1',
            content: [{ type: 'web_search_result', url: 'https://real-search-result.example/acme-candles' }],
          },
          // The model's real final text block - webCompetitorResearchTool.js parses
          // only this LAST text block (agent/core/claudeClient.js's own extractText()
          // always derives the top-level `text` field from these same content blocks,
          // so a realistic mock keeps both in agreement rather than diverging).
          { type: 'text', text: JSON.stringify(replyJson) },
        ],
      },
    });

    try {
      const response = await runOrchestratorContract('Analyze my top competitor.');
      assert.strictEqual(response.routing.plan.length, 1);
      const step = response.routing.plan[0];
      assert.strictEqual(step.selected_specialist.id, 'research');
      assert.strictEqual(step.inputs.capability_id, 'competitor_research');
      assert.strictEqual(step.inputs.tool_id, 'live_competitor_research');
      assert.strictEqual(step.errors.length, 0);
      assert.ok(step.outputs, 'expected a dispatched outcome, not a clarification_required stop');
      assert.strictEqual(step.outputs.result.research_type, 'competitor_research');
      assert.strictEqual(step.outputs.result.specialized_records[0].competitor, 'Acme Candles');
      assert.strictEqual(step.outputs.result.verification_status, 'verified');
      // Real web_search usage was actually recorded, not skipped.
      assert.strictEqual(response.tokens_used, 110);
    } finally {
      claudeClient.sendMessage = originalSendMessage;
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });

  await testAsync('MOCKED: live_competitor_research honestly reports "empty" (never fabricates) when nothing could be verified, and never fabricates through the full orchestrator pipeline', async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-not-real';
    const originalSendMessage = claudeClient.sendMessage;
    claudeClient.sendMessage = async () => ({
      text: JSON.stringify({ competitors: [] }),
      model: 'claude-sonnet-5',
      stopReason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
      raw: { content: [{ type: 'text', text: 'ok' }] },
    });

    try {
      const response = await runOrchestratorContract('Analyze my top competitor.');
      const step = response.routing.plan[0];
      assert.strictEqual(step.inputs.tool_id, 'live_competitor_research');
      assert.strictEqual(step.outputs.status, 'empty');
      assert.strictEqual(step.outputs.result, null);
    } finally {
      claudeClient.sendMessage = originalSendMessage;
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });

  await testAsync('REGRESSION: live_competitor_research never hijacks an unrelated Research capability - "market competitor research" still dispatches market_research, exactly as before this feature existed', async () => {
    const originalSendMessage = claudeClient.sendMessage;
    claudeClient.sendMessage = async () => {
      throw new Error('sendMessage/web_search must never be reached for a market_research dispatch');
    };
    try {
      const response = await runOrchestratorContract('market competitor research and social media advertising');
      const [researchStep] = response.routing.plan;
      assert.strictEqual(researchStep.inputs.tool_id, 'market_research');
      assert.strictEqual(researchStep.inputs.capability_id, 'market_research');
    } finally {
      claudeClient.sendMessage = originalSendMessage;
    }
  });

  await testAsync('REGRESSION: a plural "competitors" objective routes to competitor_research (live_competitor_research), not market_research - the natural, most common way to phrase this tied 3-3 with market_research (both tools\' text says "research" 3x, and only "competitor" - singular - appeared in competitor_research\'s own text) before tools/toolRegistry.js\'s competitor_research description was worded to also say "competitors"', async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-not-real';
    const originalSendMessage = claudeClient.sendMessage;
    claudeClient.sendMessage = async () => ({
      text: JSON.stringify({ competitors: [] }),
      model: 'claude-sonnet-5',
      stopReason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
      raw: { content: [{ type: 'text', text: 'ok' }] },
    });
    try {
      const response = await runOrchestratorContract('Research my top competitors for my digital PNG bundle products.');
      assert.strictEqual(response.routing.plan.length, 1);
      const step = response.routing.plan[0];
      assert.strictEqual(step.selected_specialist.id, 'research');
      assert.strictEqual(step.inputs.capability_id, 'competitor_research');
      assert.strictEqual(step.inputs.tool_id, 'live_competitor_research');
    } finally {
      claudeClient.sendMessage = originalSendMessage;
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });

  await testAsync('REGRESSION: "PNG and SVG bundle products" no longer splits into a spurious second Product clause - CLAUSE_SPLIT_REGEX has no grammar awareness, so a real client listing their own file formats with "and" (or a comma) must not be torn into an unrelated, unimplemented step; protectFileFormatLists() fuses a run of recognized file-format tokens before splitting happens', async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-not-real';
    const originalSendMessage = claudeClient.sendMessage;
    claudeClient.sendMessage = async () => ({
      text: JSON.stringify({ competitors: [] }),
      model: 'claude-sonnet-5',
      stopReason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
      raw: { content: [{ type: 'text', text: 'ok' }] },
    });
    try {
      const withAnd = await runOrchestratorContract(
        'Research my top competitors for my digital PNG and SVG bundle products.'
      );
      assert.strictEqual(withAnd.routing.plan.length, 1);
      assert.strictEqual(withAnd.routing.plan[0].selected_specialist.id, 'research');
      assert.strictEqual(withAnd.routing.plan[0].inputs.capability_id, 'competitor_research');
      assert.strictEqual(withAnd.routing.plan[0].inputs.tool_id, 'live_competitor_research');

      const withComma = await runOrchestratorContract(
        'Research my top competitors for my digital PNG ,SVG bundle products.'
      );
      assert.strictEqual(withComma.routing.plan.length, 1);
      assert.strictEqual(withComma.routing.plan[0].selected_specialist.id, 'research');
      assert.strictEqual(withComma.routing.plan[0].inputs.capability_id, 'competitor_research');
      assert.strictEqual(withComma.routing.plan[0].inputs.tool_id, 'live_competitor_research');

      const threeItemOxford = await runOrchestratorContract(
        'Research my top competitors for my digital PNG, SVG, and JPG bundle products.'
      );
      assert.strictEqual(threeItemOxford.routing.plan.length, 1);
      assert.strictEqual(threeItemOxford.routing.plan[0].inputs.capability_id, 'competitor_research');
    } finally {
      claudeClient.sendMessage = originalSendMessage;
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });

  await test('REGRESSION: protectFileFormatLists never touches a genuine two-task objective - "business"/"identify"/"research"/"social" are not file-format tokens, so legitimate multi-clause splitting is completely unaffected', () => {
    assert.deepStrictEqual(
      splitIntoClauses('market competitor research and social media advertising'),
      ['market competitor research', 'social media advertising']
    );
    assert.deepStrictEqual(
      splitIntoClauses('analyze my business and identify the biggest sales opportunity'),
      ['analyze my business', 'identify the biggest sales opportunity']
    );
    assert.deepStrictEqual(
      splitIntoClauses('show me my product data and improve my listing content'),
      ['show me my product data', 'improve my listing content']
    );
  });

  await test('REGRESSION: splitIntoClauses fuses a pure file-format list joined by "and"/comma into one clause, with or without an Oxford comma', () => {
    assert.deepStrictEqual(
      splitIntoClauses('Research my top competitors for my digital PNG and SVG bundle products.'),
      ['Research my top competitors for my digital PNG-SVG bundle products.']
    );
    assert.deepStrictEqual(
      splitIntoClauses('Research my top competitors for my digital PNG ,SVG bundle products.'),
      ['Research my top competitors for my digital PNG-SVG bundle products.']
    );
    assert.deepStrictEqual(
      splitIntoClauses('Research my top competitors for my digital PNG, SVG, and JPG bundle products.'),
      ['Research my top competitors for my digital PNG-SVG-JPG bundle products.']
    );
  });

  await testAsync('runOrchestratorContract: researchParams passthrough routes to market_research and executes it for real', async () => {
    const response = await runOrchestratorContract('run market research', {
      researchParams: { market: 'European Union', demandSignals: ['x'], evidence: ['y'] },
    });
    assert.strictEqual(response.routing.plan.length, 1);
    const outputs = response.routing.plan[0].outputs;
    assert.strictEqual(outputs.status, 'success');
    assert.strictEqual(outputs.result.research_type, 'market_research');
  });

  await testAsync('runOrchestratorContract: without researchParams, market_research is stopped before dispatch with a clarification, never a fabricated result', async () => {
    const response = await runOrchestratorContract('run market research');
    const step = response.routing.plan[0];
    // market_research's required field (market) has no approved live source and no
    // evidence was supplied - the orchestrator stops before ever dispatching the tool
    // (see buildPlanStep's requiredEvidenceMissing check), rather than calling it just
    // to receive its own honest 'failed' status back.
    assert.strictEqual(step.completion_state, 'blocked');
    assert.strictEqual(step.outputs, null);
    assert.ok(step.errors[0].includes('market'));
  });

  await testAsync('executeSelectedCapability: TOOL_EXECUTORS.global_market_opportunity_analysis is reachable via the real Chief dispatch path and executes for real', async () => {
    const executionRequest = {
      objective: 'analyze global market opportunity',
      category: 'research',
      tool_id: 'global_market_opportunity_analysis',
      specialist_id: 'research',
      research_params: {
        markets: [
          {
            market: 'European Union',
            category: 'outdoor apparel',
            demandSignals: ['signal A'],
            evidence: ['market-evidence-1'],
          },
        ],
      },
    };
    const outcome = await executeSelectedCapability(executionRequest);
    assert.strictEqual(outcome.status, 'success');
    assert.strictEqual(outcome.data.result.comparison.length, 1);
    assert.strictEqual(outcome.data.result.comparison[0].category.value, 'outdoor apparel');
  });

  await testAsync('executeSelectedCapability: TOOL_EXECUTORS.market_product_opportunity_analysis is reachable via the real Chief dispatch path and executes for real', async () => {
    const { compareGlobalMarkets } = require('../../workflows/globalEcommerceMarketResearchWorkflow');
    const marketRow = compareGlobalMarkets({
      markets: [
        {
          market: 'European Union',
          category: 'outdoor apparel',
          demandSignals: ['signal A'],
          evidence: ['market-evidence-1'],
          products: [{ productIdentity: 'Jacket', source: ['prod-source-1'] }],
        },
      ],
    }).comparison[0];

    const executionRequest = {
      objective: 'evaluate a product opportunity against market intelligence',
      category: 'products',
      tool_id: 'market_product_opportunity_analysis',
      specialist_id: 'product',
      research_params: { marketRow, productIdentity: 'Jacket', demandConfidence: 'medium' },
    };
    const outcome = await executeSelectedCapability(executionRequest);
    assert.strictEqual(outcome.status, 'success');
    assert.strictEqual(outcome.data.result.product_identity, 'Jacket');
    assert.strictEqual(outcome.data.result.market, 'European Union');
  });

  // --- Operational approval flow: pending -> approved/rejected -> resumed --------
  //
  // No tool in today's real registry is both implemented and approval_required (every
  // implemented tool is analysis_only or recommendation - see
  // agent/core/toolPermissions.js's TOOL_CLASSIFICATIONS and its own test's header
  // comment on this exact honest gap). To exercise the real Chief dispatch path
  // (executeSelectedCapability -> checkToolAccess -> createApprovalRequest) end-to-end
  // rather than only unit-testing approvals/approvalWorkflow.js in isolation, these
  // tests temporarily reclassify one real, implemented tool
  // (business_configuration_retrieval) via TOOL_CLASSIFICATIONS - the same
  // temporarily-reassign-and-restore-in-finally technique this file already uses for
  // claudeClient.sendMessage above - never leaving the shared registry mutated for
  // other tests.

  await testAsync('executeSelectedCapability creates a real, trackable pending request on a runApprovalTracker when approval is required', async () => {
    const originalClassification = TOOL_CLASSIFICATIONS.business_configuration_retrieval;
    TOOL_CLASSIFICATIONS.business_configuration_retrieval = 'externally_executable';
    try {
      const executionRequest = {
        objective: "check my shop's business configuration",
        category: 'configuration',
        tool_id: 'business_configuration_retrieval',
        specialist_id: null,
        is_shared_infrastructure: true,
      };
      const runApprovalTracker = { requests: [] };
      const outcome = await executeSelectedCapability(executionRequest, undefined, runApprovalTracker);

      assert.strictEqual(outcome.status, 'approval_required');
      assert.strictEqual(outcome.classification, 'externally_executable');
      assert.strictEqual(runApprovalTracker.requests.length, 1);
      const request = runApprovalTracker.requests[0];
      assert.strictEqual(request.id, outcome.approval_request_id);
      assert.strictEqual(request.status, 'pending');
      assert.strictEqual(request.tool_id, 'business_configuration_retrieval');
      assert.strictEqual(request.specialist_id, null);
      assert.deepStrictEqual(request.execution_request, executionRequest);
    } finally {
      TOOL_CLASSIFICATIONS.business_configuration_retrieval = originalClassification;
    }
  });

  await testAsync('resumeApprovedExecution refuses to run a pending or rejected request, never invoking any executor', async () => {
    const originalClassification = TOOL_CLASSIFICATIONS.business_configuration_retrieval;
    TOOL_CLASSIFICATIONS.business_configuration_retrieval = 'externally_executable';
    try {
      const executionRequest = {
        objective: "check my shop's business configuration",
        category: 'configuration',
        tool_id: 'business_configuration_retrieval',
        specialist_id: null,
        is_shared_infrastructure: true,
      };
      const runApprovalTracker = { requests: [] };
      const gated = await executeSelectedCapability(executionRequest, undefined, runApprovalTracker);
      const [pendingRequest] = runApprovalTracker.requests;

      const pendingOutcome = await resumeApprovedExecution(pendingRequest);
      assert.strictEqual(pendingOutcome.status, 'approval_required');

      const rejectedRequests = decideApprovalRequest([pendingRequest], gated.approval_request_id, {
        decision: 'rejected',
        decidedBy: 'owner@example.com',
      });
      const rejectedOutcome = await resumeApprovedExecution(rejectedRequests[0]);
      assert.strictEqual(rejectedOutcome.status, 'denied');
    } finally {
      TOOL_CLASSIFICATIONS.business_configuration_retrieval = originalClassification;
    }
  });

  await testAsync('resumeApprovedExecution actually invokes the real executor once a request has been approved, and never before', async () => {
    const savedDomain = process.env.SHOPIFY_STORE_DOMAIN;
    const savedToken = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    delete process.env.SHOPIFY_STORE_DOMAIN;
    delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    const originalClassification = TOOL_CLASSIFICATIONS.business_configuration_retrieval;
    TOOL_CLASSIFICATIONS.business_configuration_retrieval = 'externally_executable';
    try {
      const executionRequest = {
        objective: "check my shop's business configuration",
        category: 'configuration',
        tool_id: 'business_configuration_retrieval',
        specialist_id: null,
        is_shared_infrastructure: true,
      };
      const runApprovalTracker = { requests: [] };
      const gated = await executeSelectedCapability(executionRequest, undefined, runApprovalTracker);
      const [pendingRequest] = runApprovalTracker.requests;

      const approvedRequests = decideApprovalRequest([pendingRequest], gated.approval_request_id, {
        decision: 'approved',
        decidedBy: 'owner@example.com',
      });

      // The real executor is genuinely reached now (not before) - it fails fast on its
      // own "not configured" check rather than making a network call, the same
      // convention already used elsewhere in this file.
      const resumedOutcome = await resumeApprovedExecution(approvedRequests[0]);
      assert.strictEqual(resumedOutcome.status, 'error');
      assert.ok(/SHOPIFY_STORE_DOMAIN/.test(resumedOutcome.error));
    } finally {
      TOOL_CLASSIFICATIONS.business_configuration_retrieval = originalClassification;
      if (savedDomain === undefined) delete process.env.SHOPIFY_STORE_DOMAIN;
      else process.env.SHOPIFY_STORE_DOMAIN = savedDomain;
      if (savedToken === undefined) delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
      else process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = savedToken;
    }
  });

  await testAsync('resumeApprovedExecution honestly refuses when the tool became unavailable/denied since the request was created', async () => {
    const outcome = await resumeApprovedExecution({
      id: 'apr-stale',
      classification: 'externally_executable',
      specialist_id: 'marketing',
      tool_id: 'business_configuration_retrieval',
      execution_request: { objective: 'x', tool_id: 'business_configuration_retrieval', specialist_id: 'marketing' },
      reason: 'test fixture',
      status: 'approved',
      requested_at: new Date().toISOString(),
      decided_at: new Date().toISOString(),
      decided_by: 'owner@example.com',
      decision_notes: null,
    });
    // 'marketing' does not own the 'configuration' category - approval never overrides
    // permission, only the approval gate itself.
    assert.strictEqual(outcome.status, 'denied');
  });

  // --- Role-based (READ/WRITE/EXECUTE) permission: enforced before execution -----
  //
  // Every real, implemented tool today already falls inside its owning specialist's
  // role (see verification/testing/toolPermissions.test.js's own consistency check),
  // so - same honest gap/technique as the approval-flow tests above - this
  // temporarily reclassifies one real tool's `operation` via tools/toolRegistry.js's
  // mutable TOOL_REGISTRY entry, restoring it in a finally block, to prove the real
  // Chief dispatch path (executeSelectedCapability) actually enforces the role gate
  // before agent/core/orchestratorExecutionContract.js's TOOL_EXECUTORS is ever read -
  // not just that agent/core/toolPermissions.js's pure functions compute the right
  // answer in isolation.

  await testAsync('executeSelectedCapability denies a real, category-owned tool whose operation falls outside the specialist role, and never touches its executor', async () => {
    const marketResearchTool = getToolById('market_research');
    const originalOperation = marketResearchTool.operation;
    marketResearchTool.operation = 'write'; // Research's role is read-only.
    try {
      const executionRequest = {
        objective: 'run market research',
        category: 'research',
        tool_id: 'market_research',
        specialist_id: 'research',
        is_shared_infrastructure: false,
        research_params: { market: 'European Union', demandSignals: ['x'], evidence: ['y'] },
      };
      const outcome = await executeSelectedCapability(executionRequest);
      // 'denied', not 'success' or 'error' from inside the executor - the gate stops
      // dispatch before TOOL_EXECUTORS.market_research is ever called, so no real
      // research record (which the researchParams above would otherwise produce
      // successfully - see the researchParams passthrough test elsewhere in this
      // file) is ever returned.
      assert.strictEqual(outcome.status, 'denied');
      assert.strictEqual(outcome.data, null);
      assert.ok(/role does not permit 'write'/.test(outcome.error));
    } finally {
      marketResearchTool.operation = originalOperation;
    }
  });

  await testAsync('runOrchestratorContract: the full pipeline honestly reports denied (not a fabricated result) when a real plan step\'s tool falls outside its specialist\'s role', async () => {
    const marketResearchTool = getToolById('market_research');
    const originalOperation = marketResearchTool.operation;
    marketResearchTool.operation = 'write';
    try {
      const response = await runOrchestratorContract('run market research', {
        researchParams: { market: 'European Union', demandSignals: ['x'], evidence: ['y'] },
      });
      assert.strictEqual(response.routing.status, 'planned');
      const step = response.routing.plan[0];
      assert.strictEqual(step.outputs, null);
      assert.deepStrictEqual(step.errors.length, 1);
      assert.ok(/role does not permit/.test(step.errors[0]));
      assert.strictEqual(step.completion_state, 'blocked');
    } finally {
      marketResearchTool.operation = originalOperation;
    }
  });

  await testAsync('runOrchestratorContract: pending_approvals is null for a clarification-required response and an empty array for a real, fully auto-approved plan today', async () => {
    const clarificationResponse = await runOrchestratorContract('zzqxvth wobble unicorn');
    assert.strictEqual(clarificationResponse.pending_approvals, null);

    const plannedResponse = await runOrchestratorContract('keyword search visibility');
    assert.deepStrictEqual(plannedResponse.pending_approvals, []);
  });

  // --- Centralized audit trail (audit/auditTrail.js) ------------------------------

  await testAsync('runOrchestratorContract: audit_trail records request -> agent -> tools -> data_access -> execution -> result in order for a clean run, with no approval/error events', async () => {
    // Real keywords supplied - a genuine dispatch, not the "stop before dispatch"
    // clarification path (see the dedicated clarification_required audit-trail test
    // below), so the tool actually runs and the full event sequence is produced.
    const response = await runOrchestratorContract('keyword search visibility', {
      researchParams: { keywords: [{ keyword: 'winter jacket' }] },
    });
    const types = response.audit_trail.map((event) => event.type);

    assert.strictEqual(types[0], 'request');
    assert.ok(types.includes('agent'));
    assert.ok(types.includes('tools'));
    assert.ok(types.includes('data_access'));
    assert.ok(types.includes('execution'));
    assert.ok(types.includes('result'));
    assert.ok(!types.includes('approval'));
    assert.ok(!types.includes('error'));

    // Every event in one run shares the same run_id, and ids are unique/sequential.
    const runIds = new Set(response.audit_trail.map((event) => event.run_id));
    assert.strictEqual(runIds.size, 1);
    response.audit_trail.forEach((event, index) => {
      assert.strictEqual(event.id, `${event.run_id}-${index}`);
    });
  });

  await testAsync('runOrchestratorContract: audit_trail records a pending approval event and no result event for a step that never executed', async () => {
    const originalClassification = TOOL_CLASSIFICATIONS.business_configuration_retrieval;
    TOOL_CLASSIFICATIONS.business_configuration_retrieval = 'externally_executable';
    try {
      const response = await runOrchestratorContract("check my shop's business configuration");
      const approvalEvents = response.audit_trail.filter((event) => event.type === 'approval');
      assert.strictEqual(approvalEvents.length, 1);
      assert.strictEqual(approvalEvents[0].status, 'pending');
      assert.strictEqual(approvalEvents[0].tool_id, 'business_configuration_retrieval');
      // Gated before execution - no result event was ever recorded for this tool.
      const resultEvents = response.audit_trail.filter((event) => event.type === 'result');
      assert.strictEqual(resultEvents.length, 0);
    } finally {
      TOOL_CLASSIFICATIONS.business_configuration_retrieval = originalClassification;
    }
  });

  await testAsync('runOrchestratorContract: audit_trail is present alongside every existing response field, purely additive', async () => {
    // Real keywords supplied, same reason as the test above - a genuine dispatch.
    const response = await runOrchestratorContract('keyword search visibility', {
      researchParams: { keywords: [{ keyword: 'winter jacket' }] },
    });
    assert.ok(Array.isArray(response.audit_trail));
    // Every field this file's other tests already assert on is still there, unchanged.
    assert.strictEqual(response.objective, 'keyword search visibility');
    assert.strictEqual(response.routing.status, 'planned');
    assert.deepStrictEqual(response.pending_approvals, []);
    assert.ok('growth_opportunity_drafts' in response);
    assert.ok('tokens_used' in response);
    // usage/usageTracker.js's structured usage ledger - additive, mirrors audit_trail.
    assert.ok(Array.isArray(response.usage_ledger));
    assert.ok(response.usage_ledger.some((event) => event.category === 'agent_task'));
    assert.ok(response.usage_ledger.some((event) => event.category === 'tool_call'));
    assert.strictEqual(response.usage_summary.total_events, response.usage_ledger.length);
    assert.strictEqual(response.usage_summary.by_category.tool_call.count, 1);
  });

  await testAsync('runOrchestratorContract: audit_trail on a clarification-required response records only the request/error event that actually happened', async () => {
    const emptyTaskResponse = await runOrchestratorContract('');
    assert.strictEqual(emptyTaskResponse.audit_trail.length, 1);
    assert.strictEqual(emptyTaskResponse.audit_trail[0].type, 'error');
    // usage_ledger/usage_summary are present (empty/zeroed) on this path too, same
    // never-silently-dropped convention as audit_trail.
    assert.deepStrictEqual(emptyTaskResponse.usage_ledger, []);
    assert.strictEqual(emptyTaskResponse.usage_summary.total_events, 0);

    const ambiguousResponse = await runOrchestratorContract('I need content optimization help');
    assert.strictEqual(ambiguousResponse.audit_trail.length, 1);
    assert.strictEqual(ambiguousResponse.audit_trail[0].type, 'request');
    assert.deepStrictEqual(ambiguousResponse.usage_ledger, []);
    assert.strictEqual(ambiguousResponse.usage_summary.total_events, 0);
  });

  // --- Per-run tool-result cache (agent/core/toolResultCache.js) wiring -----------
  //
  // keyword_research is used as the deterministic, no-network probe throughout: its
  // real handler (agent/core/seoAgent.js's runKeywordResearch, via
  // tools/keywordResearchTool.js) builds a brand-new result object literal on every
  // real invocation, so reference-identity equality between two calls is only
  // possible when the second call was served from the cache, never from a fresh
  // execution that merely looks the same.

  function buildKeywordResearchExecutionRequest(keyword) {
    return {
      objective: 'keyword research',
      category: 'seo',
      tool_id: 'keyword_research',
      specialist_id: 'seo',
      is_shared_infrastructure: false,
      research_params: { keywords: [{ keyword, source: ['(placeholder source)'] }] },
    };
  }

  await testAsync('tool-result cache: an identical second call is served from cache (reference-identity proof)', async () => {
    const runToolResultCache = createToolResultCache();
    const request = buildKeywordResearchExecutionRequest('insulated hiking jacket');

    const first = await executeSelectedCapability(request, undefined, undefined, null, runToolResultCache);
    const second = await executeSelectedCapability(request, undefined, undefined, null, runToolResultCache);

    assert.strictEqual(first.status, 'success');
    assert.strictEqual(second.data, first.data, 'a cache hit must return the exact prior result object, not a freshly-built one');
  });

  await testAsync('tool-result cache: audit trail gains exactly 4 events on a miss and exactly 1 (cache_hit) on the identical repeat', async () => {
    const runToolResultCache = createToolResultCache();
    const runAuditTracker = createAuditTracker('run-cache-test-1');
    const request = buildKeywordResearchExecutionRequest('insulated hiking jacket');

    await executeSelectedCapability(request, undefined, undefined, runAuditTracker, runToolResultCache);
    assert.strictEqual(runAuditTracker.events.length, 4);
    assert.deepStrictEqual(
      runAuditTracker.events.map((event) => event.type),
      ['tools', 'data_access', 'execution', 'result']
    );

    await executeSelectedCapability(request, undefined, undefined, runAuditTracker, runToolResultCache);
    assert.strictEqual(runAuditTracker.events.length, 5);
    const cacheHitEvent = runAuditTracker.events[4];
    assert.strictEqual(cacheHitEvent.type, 'result');
    assert.strictEqual(cacheHitEvent.status, 'cache_hit');
  });

  await testAsync('tool-result cache: a cache-hit second call produces no additional tool_call usage event (never double-billed)', async () => {
    const runToolResultCache = createToolResultCache();
    const runUsageLedger = createUsageLedger('run-cache-usage-test-1');
    const request = buildKeywordResearchExecutionRequest('insulated hiking jacket');

    await executeSelectedCapability(request, undefined, undefined, null, runToolResultCache, null, runUsageLedger);
    assert.strictEqual(runUsageLedger.events.filter((event) => event.category === 'tool_call').length, 1);

    await executeSelectedCapability(request, undefined, undefined, null, runToolResultCache, null, runUsageLedger);
    assert.strictEqual(
      runUsageLedger.events.filter((event) => event.category === 'tool_call').length,
      1,
      'an identical cache-hit call must not record a second usage event'
    );
  });

  await testAsync('tool-result cache: different params correctly miss the cache (no false-positive matching)', async () => {
    const runToolResultCache = createToolResultCache();
    const first = await executeSelectedCapability(
      buildKeywordResearchExecutionRequest('insulated hiking jacket'),
      undefined,
      undefined,
      null,
      runToolResultCache
    );
    const second = await executeSelectedCapability(
      buildKeywordResearchExecutionRequest('lightweight rain jacket'),
      undefined,
      undefined,
      null,
      runToolResultCache
    );
    assert.strictEqual(runToolResultCache.entries.size, 2);
    assert.notStrictEqual(second.data, first.data);
  });

  await testAsync('tool-result cache: ai_reasoning_completion is explicitly excluded, even for identical calls', async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-not-real';
    const originalSendMessage = claudeClient.sendMessage;
    let callCount = 0;
    claudeClient.sendMessage = async () => {
      callCount += 1;
      return {
        text: 'Mocked reasoning output.',
        model: 'claude-sonnet-5',
        stopReason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 5 },
        raw: {},
      };
    };

    try {
      const runToolResultCache = createToolResultCache();
      const runAuditTracker = createAuditTracker('run-cache-test-2');
      const request = {
        objective: 'run a claude reasoning completion',
        category: 'ai_reasoning',
        tool_id: 'ai_reasoning_completion',
        specialist_id: null,
        is_shared_infrastructure: true,
        research_params: null,
      };

      await executeSelectedCapability(request, undefined, undefined, runAuditTracker, runToolResultCache);
      await executeSelectedCapability(request, undefined, undefined, runAuditTracker, runToolResultCache);

      assert.strictEqual(callCount, 2, 'ai_reasoning_completion must never be served from cache');
      const resultEvents = runAuditTracker.events.filter((event) => event.type === 'result');
      assert.strictEqual(resultEvents.length, 2);
      assert.ok(resultEvents.every((event) => event.status === 'success'));
    } finally {
      claudeClient.sendMessage = originalSendMessage;
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });

  await testAsync('tool-result cache: an error outcome (business_configuration_retrieval, not configured) is never cached', async () => {
    const savedDomain = process.env.SHOPIFY_STORE_DOMAIN;
    const savedToken = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    delete process.env.SHOPIFY_STORE_DOMAIN;
    delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    try {
      const runToolResultCache = createToolResultCache();
      const runAuditTracker = createAuditTracker('run-cache-test-3');
      const capability = identifyRequiredCapability("check my shop's business configuration");
      const request = createExecutionRequest("check my shop's business configuration", capability);

      await executeSelectedCapability(request, undefined, undefined, runAuditTracker, runToolResultCache);
      await executeSelectedCapability(request, undefined, undefined, runAuditTracker, runToolResultCache);

      assert.strictEqual(runToolResultCache.entries.size, 0, 'an error outcome must never populate the cache');
      const errorEvents = runAuditTracker.events.filter((event) => event.type === 'error');
      const cacheHitEvents = runAuditTracker.events.filter((event) => event.status === 'cache_hit');
      assert.strictEqual(errorEvents.length, 2, 'both calls should fail independently, not hit a cache');
      assert.strictEqual(cacheHitEvents.length, 0);
    } finally {
      if (savedDomain === undefined) delete process.env.SHOPIFY_STORE_DOMAIN;
      else process.env.SHOPIFY_STORE_DOMAIN = savedDomain;
      if (savedToken === undefined) delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
      else process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = savedToken;
    }
  });

  // --- Bounded research calls / bounded agent iterations (agent/core/executionBounds.js) ---

  await testAsync('executeSelectedCapability refuses a research_params array field over MAX_ARRAY_FIELD_ENTRIES, without executing', async () => {
    await withEnv('MAX_ARRAY_FIELD_ENTRIES', '2', async () => {
      const runAuditTracker = createAuditTracker('run-bounds-test-1');
      const request = {
        objective: 'keyword research',
        category: 'seo',
        tool_id: 'keyword_research',
        specialist_id: 'seo',
        is_shared_infrastructure: false,
        research_params: {
          keywords: [
            { keyword: 'insulated hiking jacket' },
            { keyword: 'lightweight rain jacket' },
            { keyword: 'waterproof hiking boots' },
          ],
        },
      };
      const outcome = await executeSelectedCapability(request, undefined, undefined, runAuditTracker);
      assert.strictEqual(outcome.status, 'error');
      assert.ok(/keywords/.test(outcome.error));
      assert.ok(/exceeding the maximum of 2/.test(outcome.error));
      const errorEvents = runAuditTracker.events.filter((event) => event.type === 'error');
      assert.strictEqual(errorEvents.length, 1);
      const executionEvents = runAuditTracker.events.filter((event) => event.type === 'execution');
      assert.strictEqual(executionEvents.length, 0, 'the tool must never actually execute once the bounds check refuses it');
    });
  });

  await testAsync('executeSelectedCapability allows a research_params array field within MAX_ARRAY_FIELD_ENTRIES', async () => {
    await withEnv('MAX_ARRAY_FIELD_ENTRIES', '5', async () => {
      const request = {
        objective: 'keyword research',
        category: 'seo',
        tool_id: 'keyword_research',
        specialist_id: 'seo',
        is_shared_infrastructure: false,
        research_params: { keywords: [{ keyword: 'insulated hiking jacket', source: ['(placeholder)'] }] },
      };
      const outcome = await executeSelectedCapability(request);
      assert.strictEqual(outcome.status, 'success');
    });
  });

  await testAsync('runOrchestratorContract refuses a plan exceeding MAX_PLAN_STEPS_PER_RUN, without executing any step', async () => {
    await withEnv('MAX_PLAN_STEPS_PER_RUN', '1', async () => {
      const response = await runOrchestratorContract('market competitor research and social media advertising');
      assert.strictEqual(response.needs_more_information, true);
      assert.strictEqual(response.routing.status, 'clarification_required');
      assert.strictEqual(response.routing.clarification_type, 'plan_too_large');
      assert.strictEqual(response.routing.plan, null);
      assert.ok(/exceeding the maximum of 1/.test(response.routing.reason));
      // Only the request + this one error event - no 'agent'/'tools'/'execution' event
      // anywhere, proving no step was ever attempted.
      assert.deepStrictEqual(
        response.audit_trail.map((event) => event.type),
        ['request', 'error']
      );
    });
  });

  await testAsync('runOrchestratorContract with the default MAX_PLAN_STEPS_PER_RUN (20) is unaffected by a real multi-target plan (2 steps)', async () => {
    const response = await runOrchestratorContract('market competitor research and social media advertising');
    assert.strictEqual(response.routing.status, 'planned');
    assert.strictEqual(response.routing.plan.length, 2);
  });

  // --- Configurable usage limits (agent/core/usageLimits.js) ---

  await testAsync('executeSelectedCapability refuses a real dispatch once MAX_TOOL_CALLS_PER_RUN is reached, without executing', async () => {
    await withEnv('MAX_TOOL_CALLS_PER_RUN', '1', async () => {
      const runUsageTracker = createUsageTracker();
      const runAuditTracker = createAuditTracker('run-usage-test-1');
      const request = buildKeywordResearchExecutionRequest('insulated hiking jacket');

      const first = await executeSelectedCapability(request, undefined, undefined, runAuditTracker, undefined, runUsageTracker);
      assert.strictEqual(first.status, 'success');
      assert.strictEqual(runUsageTracker.toolCalls, 1);

      const second = await executeSelectedCapability(request, undefined, undefined, runAuditTracker, undefined, runUsageTracker);
      assert.strictEqual(second.status, 'error');
      assert.ok(/tool calls/.test(second.error));
      assert.ok(/budget of 1/.test(second.error));
      const executionEvents = runAuditTracker.events.filter((event) => event.type === 'execution');
      assert.strictEqual(executionEvents.length, 1, 'the second call must never actually execute once the tool-call budget is exhausted');
    });
  });

  await testAsync('executeSelectedCapability refuses ai_reasoning_completion once MAX_MODEL_CALLS_PER_RUN is reached, even though the generic tool-call budget remains', async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-not-real';
    const originalSendMessage = claudeClient.sendMessage;
    let callCount = 0;
    claudeClient.sendMessage = async () => {
      callCount += 1;
      return {
        text: 'Mocked reasoning output.',
        model: 'claude-sonnet-5',
        stopReason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 5 },
        raw: {},
      };
    };

    try {
      await withEnv('MAX_MODEL_CALLS_PER_RUN', '1', async () => {
        const runUsageTracker = createUsageTracker();
        const request = {
          objective: 'run a claude reasoning completion',
          category: 'ai_reasoning',
          tool_id: 'ai_reasoning_completion',
          specialist_id: null,
          is_shared_infrastructure: true,
          research_params: null,
        };

        const first = await executeSelectedCapability(request, undefined, undefined, null, undefined, runUsageTracker);
        assert.strictEqual(first.status, 'success');

        const second = await executeSelectedCapability(request, undefined, undefined, null, undefined, runUsageTracker);
        assert.strictEqual(second.status, 'error');
        assert.ok(/model calls/.test(second.error));
        assert.strictEqual(callCount, 1, 'the second call must never reach claudeClient.sendMessage once the model-call budget is exhausted');
      });
    } finally {
      claudeClient.sendMessage = originalSendMessage;
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });

  await testAsync('a tool-result cache hit does not consume any usage budget', async () => {
    const runToolResultCache = createToolResultCache();
    const runUsageTracker = createUsageTracker();
    const request = buildKeywordResearchExecutionRequest('insulated hiking jacket');

    await executeSelectedCapability(request, undefined, undefined, null, runToolResultCache, runUsageTracker);
    assert.strictEqual(runUsageTracker.toolCalls, 1);
    assert.strictEqual(runUsageTracker.researchCalls, 1);

    await executeSelectedCapability(request, undefined, undefined, null, runToolResultCache, runUsageTracker);
    assert.strictEqual(runUsageTracker.toolCalls, 1, 'a cache hit must not increment the usage tracker');
    assert.strictEqual(runUsageTracker.researchCalls, 1, 'a cache hit must not increment the usage tracker');
  });

  await testAsync('runOrchestratorContract with default usage-limit settings is unaffected by a real multi-target plan (2 steps)', async () => {
    const response = await runOrchestratorContract('market competitor research and social media advertising');
    assert.strictEqual(response.routing.status, 'planned');
    assert.strictEqual(response.routing.plan.length, 2);
    // Neither step supplies researchParams here, so both tools honestly report their
    // own tool-level 'failed' status (missing structured input) - the point of this
    // test is that usage-limit bookkeeping itself is unaffected by a 2-step plan, not
    // that the steps succeed; each step still only used exactly one tool call.
    assert.ok(response.routing.plan.every((step) => step.tool_calls.length === 1));
  });

  test('buildRoutingResponse dedupes identical failed_work entries across plan steps', () => {
    const fakePlan = [
      { completion_state: 'failed', errors: ['Same error message'] },
      { completion_state: 'failed', errors: ['Same error message'] },
    ];
    const response = buildRoutingResponse({
      objective: 'test objective',
      routing: { status: 'planned', clarification_type: null, reason: null, candidates: null, unmatched_segment: null, plan: fakePlan },
    });
    assert.deepStrictEqual(response.state.failed_work, ['Same error message']);
  });

  // ---------------------------------------------------------------------------------
  // Regression coverage: the Chief orchestration/data-acquisition gap the latest Chief
  // Agent tests surfaced for "Analyze my ecommerce business and identify the single
  // biggest opportunity to increase sales." - see this file's own header for the wider
  // pipeline this exercises.
  // ---------------------------------------------------------------------------------

  await testAsync('TEST A: a free-text objective that word-overlap would match to market_product_opportunity_analysis (needs an unobtainable marketRow) is redirected to the live, self-sufficient product_discovery path instead - never dispatched with fabricated marketRow/productIdentity', async () => {
    const response = await runOrchestratorContract(
      'Analyze my ecommerce business and identify the single biggest opportunity to increase sales.'
    );
    // market_product_opportunity_analysis itself is never dispatched - the
    // cross-capability live-data fallback (buildPlanStep, right after the
    // same-capability override) redirects to product_discovery's live Shopify pull
    // instead, since no caller evidence was supplied and no live source can ever
    // produce a marketRow.
    const marketConnectedStep = response.routing.plan.find(
      (step) => step.inputs && step.inputs.tool_id === 'market_product_opportunity_analysis'
    );
    assert.strictEqual(marketConnectedStep, undefined, 'market_product_opportunity_analysis must never be dispatched here');

    const productStep = response.routing.plan.find((step) => step.selected_specialist && step.selected_specialist.id === 'product');
    assert.ok(productStep, 'expected a product step');
    assert.strictEqual(productStep.inputs.tool_id, 'product_data_retrieval');
    assert.strictEqual(productStep.inputs.capability_id, 'product_discovery');
    // Real, honest data or a real, honest failure either way - never fabricated
    // marketRow/productIdentity anywhere in the step, regardless of outcome.
    assert.strictEqual(JSON.stringify(productStep).includes('marketRow'), false);
  });

  await testAsync('TEST B: a sales-growth request prefers the live, read-only analytics_data_retrieval tool over the caller-evidence-only analytics tool when no evidence was supplied', async () => {
    const savedDomain = process.env.SHOPIFY_STORE_DOMAIN;
    const savedToken = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    const savedClientId = process.env.SHOPIFY_CLIENT_ID;
    const savedClientSecret = process.env.SHOPIFY_CLIENT_SECRET;
    process.env.SHOPIFY_STORE_DOMAIN = 'test-store.myshopify.com';
    process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = 'shpat_test-token-not-real';
    // A real local .env may legitimately have SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET
    // set (Client Credentials is the preferred auth path - see
    // integrations/adapters/shopifyClient.js's precedence note). Cleared here so this
    // "static token" scenario is actually isolated to the static-token code path
    // regardless of local .env contents. loadShopifyEnvOnce() is forced first so the
    // real .env's one-time load (see shopifyClient.js's envLoadAttempted guard) can
    // never happen AFTER the deletes below and silently repopulate them.
    loadShopifyEnvOnce();
    delete process.env.SHOPIFY_CLIENT_ID;
    delete process.env.SHOPIFY_CLIENT_SECRET;
    const savedFetch = global.fetch;
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          data: {
            orders: {
              edges: [
                {
                  node: {
                    id: 'gid://shopify/Order/1',
                    name: '#1001',
                    createdAt: '2026-01-15T10:00:00Z',
                    displayFinancialStatus: 'PAID',
                    displayFulfillmentStatus: 'FULFILLED',
                    currentTotalPriceSet: { shopMoney: { amount: '89.00', currencyCode: 'USD' } },
                    lineItems: { edges: [{ node: { title: 'Insulated Jacket', quantity: 1, sku: 'JCK-001' } }] },
                  },
                },
              ],
            },
          },
        }),
      };
    };
    try {
      const response = await runOrchestratorContract(
        'Analyze my ecommerce business and identify the single biggest opportunity to increase sales.'
      );
      const analyticsStep = response.routing.plan.find(
        (step) => step.selected_specialist && step.selected_specialist.id === 'analytics_optimization'
      );
      assert.ok(analyticsStep, 'expected an analytics_optimization step');
      // Real, minimum-necessary business data was gathered before specialist
      // analysis - the Chief preferred the live Shopify pull over the tool that can
      // only ever compose caller-supplied evidence (which this free-text request
      // never supplied).
      assert.deepStrictEqual(analyticsStep.tool_calls, ['analytics_data_retrieval']);
      assert.strictEqual(analyticsStep.completion_state, 'complete');
      assert.strictEqual(analyticsStep.outputs.status, 'success');
      const salesRecord = analyticsStep.outputs.result.specialized_records[0].sales;
      assert.strictEqual(salesRecord.actual_metrics[0].orderId, 'gid://shopify/Order/1');
      // 2, not 1: this objective also routes a Product step to its own live
      // product_discovery path (the cross-capability live-data fallback - see TEST A
      // above), which makes its own separate live call against the same mocked
      // fetch. The point this assertion still proves - the live Shopify client is
      // called, not the caller-evidence-only path - holds regardless of how many
      // steps in the plan each independently prefer live data over none.
      assert.strictEqual(calls, 2, 'the live Shopify client should be called once per live-data step (analytics_data_retrieval, product_data_retrieval)');
    } finally {
      global.fetch = savedFetch;
      if (savedDomain === undefined) delete process.env.SHOPIFY_STORE_DOMAIN;
      else process.env.SHOPIFY_STORE_DOMAIN = savedDomain;
      if (savedToken === undefined) delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
      else process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = savedToken;
      if (savedClientId === undefined) delete process.env.SHOPIFY_CLIENT_ID;
      else process.env.SHOPIFY_CLIENT_ID = savedClientId;
      if (savedClientSecret === undefined) delete process.env.SHOPIFY_CLIENT_SECRET;
      else process.env.SHOPIFY_CLIENT_SECRET = savedClientSecret;
    }
  });

  // --- Phase 1: central structured-input preparation pipeline ----------------------
  //
  // Covers agent/core/orchestratorExecutionContract.js's product_data_retrieval/
  // collection_data_retrieval TOOL_EXECUTORS wiring, specialistCapabilityRegistry.js's
  // live_data_tool_id field, buildPlanStep's generalized live-data-preference override,
  // crossAgentContext.js's deriveLiveEvidenceContext, and buildPlanStep's
  // requiredEvidenceMissing pre-dispatch clarification stop - see this file's own git
  // history for the full design rationale.

  await testAsync('PHASE 1: a free-text product request retrieves real live Shopify product data and reports it as a validated productModel record, never fabricated', async () => {
    const savedDomain = process.env.SHOPIFY_STORE_DOMAIN;
    const savedToken = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    const savedClientId = process.env.SHOPIFY_CLIENT_ID;
    const savedClientSecret = process.env.SHOPIFY_CLIENT_SECRET;
    loadShopifyEnvOnce();
    process.env.SHOPIFY_STORE_DOMAIN = 'test-store.myshopify.com';
    process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = 'shpat_test-token-not-real';
    delete process.env.SHOPIFY_CLIENT_ID;
    delete process.env.SHOPIFY_CLIENT_SECRET;
    const savedFetch = global.fetch;
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          data: {
            products: {
              edges: [
                {
                  node: {
                    id: 'gid://shopify/Product/1',
                    title: 'Insulated Jacket',
                    handle: 'insulated-jacket',
                    status: 'ACTIVE',
                    productType: 'Outerwear',
                    vendor: 'Acme',
                    tags: ['winter'],
                    variants: { edges: [{ node: { id: 'v1', title: 'Default', sku: 'JCK-001', price: '89.00', inventoryQuantity: 12, availableForSale: true } }] },
                    collections: { edges: [] },
                    metafields: { edges: [] },
                  },
                },
              ],
            },
          },
        }),
      };
    };
    try {
      const response = await runOrchestratorContract('show me my product data');
      const step = response.routing.plan[0];
      assert.strictEqual(step.selected_specialist.id, 'product');
      assert.strictEqual(step.inputs.tool_id, 'product_data_retrieval');
      assert.strictEqual(step.inputs.capability_id, 'product_discovery');
      assert.strictEqual(step.completion_state, 'complete');
      assert.strictEqual(step.outputs.status, 'success');
      const [record] = step.outputs.result;
      assert.strictEqual(record.product_identity, 'Insulated Jacket');
      assert.strictEqual(record.source[0], 'Shopify product gid://shopify/Product/1 (insulated-jacket)');
      assert.strictEqual(calls, 1, 'the live Shopify client should be called exactly once');
    } finally {
      global.fetch = savedFetch;
      if (savedDomain === undefined) delete process.env.SHOPIFY_STORE_DOMAIN;
      else process.env.SHOPIFY_STORE_DOMAIN = savedDomain;
      if (savedToken === undefined) delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
      else process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = savedToken;
      if (savedClientId === undefined) delete process.env.SHOPIFY_CLIENT_ID;
      else process.env.SHOPIFY_CLIENT_ID = savedClientId;
      if (savedClientSecret === undefined) delete process.env.SHOPIFY_CLIENT_SECRET;
      else process.env.SHOPIFY_CLIENT_SECRET = savedClientSecret;
    }
  });

  await testAsync('PHASE 1: Listing automatically receives one freshly-retrieved live product\'s real evidence from an earlier Product step in the same plan', async () => {
    const savedDomain = process.env.SHOPIFY_STORE_DOMAIN;
    const savedToken = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    const savedClientId = process.env.SHOPIFY_CLIENT_ID;
    const savedClientSecret = process.env.SHOPIFY_CLIENT_SECRET;
    loadShopifyEnvOnce();
    process.env.SHOPIFY_STORE_DOMAIN = 'test-store.myshopify.com';
    process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = 'shpat_test-token-not-real';
    delete process.env.SHOPIFY_CLIENT_ID;
    delete process.env.SHOPIFY_CLIENT_SECRET;
    const savedFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        data: {
          products: {
            edges: [
              {
                node: {
                  id: 'gid://shopify/Product/1',
                  title: 'Insulated Jacket',
                  handle: 'insulated-jacket',
                  status: 'ACTIVE',
                  productType: 'Outerwear',
                  vendor: 'Acme',
                  tags: [],
                  variants: { edges: [{ node: { id: 'v1', title: 'Default', sku: 'JCK-001', price: '89.00', inventoryQuantity: 12, availableForSale: true } }] },
                  collections: { edges: [] },
                  metafields: { edges: [] },
                },
              },
            ],
          },
        },
      }),
    });
    try {
      const response = await runOrchestratorContract('show me my product data and improve my listing content');
      const [productStep, listingStep] = response.routing.plan;
      assert.strictEqual(productStep.selected_specialist.id, 'product');
      assert.strictEqual(productStep.completion_state, 'complete');
      assert.strictEqual(listingStep.selected_specialist.id, 'listing');
      // productReference is still not supplied (the real gap this task's declared
      // input_contract names), but productInfo.description WAS derived from the one
      // real product Product just retrieved live - real evidence relayed, not
      // fabricated, and not enough alone to satisfy the required field.
      assert.strictEqual(listingStep.completion_state, 'blocked');
      assert.ok(listingStep.errors[0].includes('productReference'));
    } finally {
      global.fetch = savedFetch;
      if (savedDomain === undefined) delete process.env.SHOPIFY_STORE_DOMAIN;
      else process.env.SHOPIFY_STORE_DOMAIN = savedDomain;
      if (savedToken === undefined) delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
      else process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = savedToken;
      if (savedClientId === undefined) delete process.env.SHOPIFY_CLIENT_ID;
      else process.env.SHOPIFY_CLIENT_ID = savedClientId;
      if (savedClientSecret === undefined) delete process.env.SHOPIFY_CLIENT_SECRET;
      else process.env.SHOPIFY_CLIENT_SECRET = savedClientSecret;
    }
  });

  await testAsync('PHASE 1: a clarification_required stop happens BEFORE dispatch - no tool/data_access/execution/result audit events, no usage tool_call event', async () => {
    const response = await runOrchestratorContract('keyword search visibility');
    const step = response.routing.plan[0];
    assert.strictEqual(step.completion_state, 'blocked');
    const auditTypes = response.audit_trail.map((event) => event.type);
    assert.ok(!auditTypes.includes('tools'), 'no tools audit event - the tool was never dispatched');
    assert.ok(!auditTypes.includes('data_access'));
    assert.ok(!auditTypes.includes('execution'));
    assert.ok(!auditTypes.includes('result'));
    assert.ok(!response.usage_ledger.some((event) => event.category === 'tool_call'), 'no tool_call usage event was recorded');
  });

  await testAsync('PHASE 1: zero AI/model calls occur anywhere in this deterministic pipeline for a mixed free-text request', async () => {
    const response = await runOrchestratorContract(
      'Analyze my ecommerce business and identify the single biggest opportunity to increase sales.'
    );
    const modelCallEvents = response.usage_ledger.filter((event) => event.category === 'model_call');
    assert.strictEqual(modelCallEvents.length, 0, 'no ai_reasoning_completion call was ever made - routing/matching/preparation is fully deterministic');
  });

  await testAsync('PHASE 1: product_data_retrieval reports an honest failed status via the real orchestrator dispatch when Shopify is not configured, never a fabricated result', async () => {
    const savedDomain = process.env.SHOPIFY_STORE_DOMAIN;
    const savedToken = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    const savedClientId = process.env.SHOPIFY_CLIENT_ID;
    const savedClientSecret = process.env.SHOPIFY_CLIENT_SECRET;
    delete process.env.SHOPIFY_STORE_DOMAIN;
    delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    delete process.env.SHOPIFY_CLIENT_ID;
    delete process.env.SHOPIFY_CLIENT_SECRET;
    try {
      const response = await runOrchestratorContract('show me my product data');
      const step = response.routing.plan[0];
      assert.strictEqual(step.inputs.tool_id, 'product_data_retrieval');
      assert.strictEqual(step.completion_state, 'failed');
      assert.strictEqual(step.outputs.status, 'failed');
      assert.strictEqual(step.outputs.result, null);
      assert.ok(/SHOPIFY_STORE_DOMAIN/.test(step.outputs.error));
    } finally {
      if (savedDomain === undefined) delete process.env.SHOPIFY_STORE_DOMAIN;
      else process.env.SHOPIFY_STORE_DOMAIN = savedDomain;
      if (savedToken === undefined) delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
      else process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = savedToken;
      if (savedClientId === undefined) delete process.env.SHOPIFY_CLIENT_ID;
      else process.env.SHOPIFY_CLIENT_ID = savedClientId;
      if (savedClientSecret === undefined) delete process.env.SHOPIFY_CLIENT_SECRET;
      else process.env.SHOPIFY_CLIENT_SECRET = savedClientSecret;
    }
  });

  // --- Phase 1 real-world regression: routing gaps found in manual testing ---------
  //
  // Covers ROUTING_SYNONYMS's new 'product' entry and buildPlanStep's new
  // cross-capability live-data fallback (both added right after the same-capability
  // override) - see this file's own git history for the full investigation.

  await testAsync('PHASE 1 REGRESSION: "Analyze my Shopify products and identify the single best product opportunity to increase sales." uses the live Product path, never the unobtainable market_product_opportunity_analysis dead end, and never adds an unrelated configuration step', async () => {
    const response = await runOrchestratorContract(
      'Analyze my Shopify products and identify the single best product opportunity to increase sales.'
    );
    assert.strictEqual(response.routing.plan.length, 1, 'both clauses should resolve to the same Product target and dedupe into one step');
    const step = response.routing.plan[0];
    assert.strictEqual(step.selected_specialist.id, 'product');
    assert.strictEqual(step.inputs.tool_id, 'product_data_retrieval');
    assert.strictEqual(step.inputs.capability_id, 'product_discovery');
    assert.ok(
      !response.routing.plan.some((s) => s.selected_specialist && s.selected_specialist.id === 'configuration'),
      'no unrelated configuration step should be added for a single-intent product request'
    );
  });

  await testAsync('PHASE 1 REGRESSION: a "Shopify products"-only clause routes to Product, not configuration', () => {
    const routed = routeClause('Show me my Shopify products');
    assert.strictEqual(routed.status, 'matched');
    assert.strictEqual(routed.target.type, 'specialist');
    assert.strictEqual(routed.target.id, 'product');
  });

  await testAsync('PHASE 1 REGRESSION: a genuinely configuration-only request still routes to configuration - the new "shopify"/"products" vocabulary does not overreach', () => {
    const routed = routeClause("check my shop's business configuration");
    assert.strictEqual(routed.status, 'matched');
    assert.strictEqual(routed.target.type, 'shared_infrastructure');
    assert.strictEqual(routed.target.id, 'configuration');
  });

  await testAsync('PHASE 1 REGRESSION: a capability with genuinely no live sibling anywhere (SEO) still correctly returns clarification_required, unaffected by the cross-capability live-data fallback', async () => {
    const response = await runOrchestratorContract('keyword search visibility');
    const step = response.routing.plan[0];
    assert.strictEqual(step.inputs.tool_id, 'keyword_research');
    assert.strictEqual(step.completion_state, 'blocked');
    assert.strictEqual(step.outputs, null);
    assert.ok(step.errors[0].includes('keywords'));
  });

  // --- Phase 1 real-world-testing fix: markets derived from approved business config --

  await testAsync('deriveBusinessConfigContext: derives markets from the real configuration/business.yaml countries field, stripping only the (primary)/(secondary) qualifier', () => {
    const context = deriveBusinessConfigContext({ toCapabilityId: 'global_market_opportunity_analysis' });
    assert.ok(Array.isArray(context.markets));
    assert.deepStrictEqual(context.markets, [
      { market: 'United States', country: 'United States' },
      { market: 'United Kingdom', country: 'United Kingdom' },
      { market: 'Canada', country: 'Canada' },
      { market: 'Australia', country: 'Australia' },
      {
        market: 'Worldwide customers who use English-language digital marketplaces',
        country: 'Worldwide customers who use English-language digital marketplaces',
      },
    ]);
  });

  await testAsync('deriveBusinessConfigContext: never fires for any capability other than global_market_opportunity_analysis, even with real config present', () => {
    assert.deepStrictEqual(deriveBusinessConfigContext({ toCapabilityId: 'market_research' }), {});
    assert.deepStrictEqual(deriveBusinessConfigContext({ toCapabilityId: 'keyword_research' }), {});
    assert.deepStrictEqual(deriveBusinessConfigContext({ toCapabilityId: null }), {});
  });

  await testAsync('deriveBusinessConfigContext: returns {} (never guesses) when business.yaml does not exist at the given path', () => {
    const missingPath = path.join(__dirname, 'does-not-exist-business.yaml');
    assert.deepStrictEqual(
      deriveBusinessConfigContext({ toCapabilityId: 'global_market_opportunity_analysis', configPath: missingPath }),
      {}
    );
  });

  await testAsync('deriveBusinessConfigContext: returns {} (never fabricates a placeholder) when the config exists but countries is empty', () => {
    const blankTemplatePath = path.join(__dirname, '..', '..', 'configuration', 'business.example.yaml');
    assert.deepStrictEqual(
      deriveBusinessConfigContext({ toCapabilityId: 'global_market_opportunity_analysis', configPath: blankTemplatePath }),
      {}
    );
  });

  await testAsync('runOrchestratorContract: the exact real-world objective ("Research the best market opportunity for my ecommerce products.") now dispatches instead of stopping for clarification, using only real business-config markets and no fabricated evidence', async () => {
    const response = await runOrchestratorContract('Research the best market opportunity for my ecommerce products.');
    const step = response.routing.plan[0];
    assert.strictEqual(step.selected_specialist.id, 'research');
    assert.strictEqual(step.inputs.tool_id, 'global_market_opportunity_analysis');
    assert.strictEqual(step.errors.length, 0);
    assert.ok(step.outputs, 'expected a dispatched outcome, not a clarification_required stop');
    const result = step.outputs.result;
    assert.deepStrictEqual(
      result.markets_compared,
      [
        'United States',
        'United Kingdom',
        'Canada',
        'Australia',
        'Worldwide customers who use English-language digital marketplaces',
      ]
    );
    // Every facet must be honestly empty (has_evidence: false) - business.yaml supplies
    // real market names only, never invented demand/competition/pricing evidence.
    for (const row of result.comparison) {
      assert.strictEqual(row.category.has_evidence, false);
      assert.strictEqual(row.demand_signals.has_evidence, false);
      assert.strictEqual(row.competition.status, 'empty');
      assert.strictEqual(row.products.status, 'empty');
    }
  });

  await testAsync('runOrchestratorContract: an explicit caller-supplied markets list always wins over the business-config-derived one', async () => {
    const response = await runOrchestratorContract(
      'Research the best market opportunity for my ecommerce products.',
      { researchParams: { markets: [{ market: 'Caller-Supplied Market', evidence: ['caller-evidence-1'] }] } }
    );
    const step = response.routing.plan[0];
    assert.deepStrictEqual(step.outputs.result.markets_compared, ['Caller-Supplied Market']);
  });

  await testAsync('PHASE 1 REGRESSION: without researchParams, market_research (a sibling capability with no business.yaml mapping) still correctly returns clarification_required, unaffected by the new business-config derivation', async () => {
    const response = await runOrchestratorContract('run market research');
    const step = response.routing.plan[0];
    assert.strictEqual(step.completion_state, 'blocked');
    assert.strictEqual(step.outputs, null);
    assert.ok(step.errors[0].includes('market'));
  });

  test('TEST C: validateResult never marks a tool-level failure as passed just because the executor call itself did not throw', () => {
    // Exactly runExecutor's own shape (agent/core/orchestratorExecutionContract.js) for
    // a tool that followed its honest { status, result, error } convention (see
    // agent/core/executionState.js's getToolResultStatus) but could not actually run.
    const outcome = {
      status: 'success',
      data: { status: 'failed', result: null, error: 'requires structured input this request did not supply' },
      error: null,
      classification: 'analysis_only',
    };
    assert.strictEqual(validateResult(outcome), 'failed');

    const emptyOutcome = {
      status: 'success',
      data: { status: 'empty', result: { findings: [] }, error: null },
      error: null,
      classification: 'analysis_only',
    };
    assert.strictEqual(validateResult(emptyOutcome), 'unverified');

    const realSuccessOutcome = {
      status: 'success',
      data: { status: 'success', result: { findings: ['x'] }, error: null },
      error: null,
      classification: 'analysis_only',
    };
    assert.strictEqual(validateResult(realSuccessOutcome), 'passed');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();
