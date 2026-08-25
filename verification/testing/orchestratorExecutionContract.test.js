'use strict';

const assert = require('node:assert');
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
  runOrchestratorContract,
} = require('../../agent/core/orchestratorExecutionContract');
const claudeClient = require('../../agent/core/claudeClient');
const { getMaxTokensPerRun } = require('../../agent/core/tokenControls');
const { TOOL_CLASSIFICATIONS } = require('../../agent/core/toolPermissions');
const { decideApprovalRequest } = require('../../approvals/approvalWorkflow');
const { getToolById } = require('../../tools/toolRegistry');

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
    // keyword_research is implemented and its matched capability (keyword_research)
    // is injected into researchParams (see agent/core/orchestratorExecutionContract.js's
    // TOOL_CAPABILITY_SELECTORS), so the tool receives a non-null researchParams and
    // reports the specific real gap (no keywords array) rather than a generic
    // "nothing was supplied at all" message - honest and more precise, never a
    // fabricated result.
    assert.strictEqual(step.completion_state, 'complete');
    assert.strictEqual(step.outputs.status, 'failed');
    assert.strictEqual(step.outputs.result, null);
    assert.ok(step.outputs.error.includes('requires a non-empty `keywords` array'));
  });

  await testAsync('runOrchestratorContract: a clean single-specialist task (Listing) produces a one-step plan of shared execution state', async () => {
    const response = await runOrchestratorContract('improve my listing content');
    assert.strictEqual(response.needs_more_information, false);
    assert.strictEqual(response.routing.status, 'planned');
    assert.strictEqual(response.routing.plan.length, 1);
    const step = response.routing.plan[0];
    assert.strictEqual(step.selected_specialist.id, 'listing');
    assert.deepStrictEqual(step.tool_calls, ['listing_content_generation']);
    // listing_content_generation is implemented and its matched capability
    // (listing_content) is injected into researchParams, so the tool reports the
    // specific real gap (no productReference) rather than a generic
    // "nothing was supplied at all" message.
    assert.strictEqual(step.completion_state, 'complete');
    assert.strictEqual(step.outputs.status, 'failed');
    assert.strictEqual(step.outputs.result, null);
    assert.ok(step.outputs.error.includes('requires a non-empty `productReference` string'));
  });

  await testAsync('runOrchestratorContract: a clean single-specialist task (Marketing) produces a one-step plan of shared execution state', async () => {
    const response = await runOrchestratorContract('marketing campaign strategy');
    assert.strictEqual(response.needs_more_information, false);
    assert.strictEqual(response.routing.status, 'planned');
    assert.strictEqual(response.routing.plan.length, 1);
    const step = response.routing.plan[0];
    assert.strictEqual(step.selected_specialist.id, 'marketing');
    assert.deepStrictEqual(step.tool_calls, ['marketing_analysis']);
    // marketing_analysis is implemented and its matched capability (marketing_strategy)
    // is injected into researchParams, so the tool reports the specific real gap (no
    // marketingChannel) rather than a generic "nothing was supplied at all" message.
    assert.strictEqual(step.completion_state, 'complete');
    assert.strictEqual(step.outputs.status, 'failed');
    assert.strictEqual(step.outputs.result, null);
    assert.ok(step.outputs.error.includes('requires a non-empty `marketingChannel` string'));
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
    // clause's own wording ("social", "media"); its matched capability (instagram, the
    // tool's own default) is injected into researchParams, so the tool reports the
    // specific real gap (no contentReference) rather than a generic
    // "nothing was supplied at all" message.
    assert.deepStrictEqual(socialStep.tool_calls, ['social_content_planning']);
    assert.strictEqual(socialStep.completion_state, 'complete');
    assert.strictEqual(socialStep.outputs.status, 'failed');
    assert.strictEqual(socialStep.outputs.result, null);
    assert.ok(socialStep.outputs.error.includes('requires a non-empty `contentReference` string'));
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
    assert.deepStrictEqual(step.inputs.input_contract, { required: ['keywords', 'keywords[].keyword'], optional: [] });
  });

  await testAsync('runOrchestratorContract: a matched tool with zero connected capabilities (Product) honestly reports capability_id null, never guessed', async () => {
    const response = await runOrchestratorContract('run product research on my catalog');
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
    const response = await runOrchestratorContract('seo analysis and refresh my listing', {
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

  await testAsync('runOrchestratorContract: researchParams passthrough routes to market_research and executes it for real', async () => {
    const response = await runOrchestratorContract('run market research', {
      researchParams: { market: 'European Union', demandSignals: ['x'], evidence: ['y'] },
    });
    assert.strictEqual(response.routing.plan.length, 1);
    const outputs = response.routing.plan[0].outputs;
    assert.strictEqual(outputs.status, 'success');
    assert.strictEqual(outputs.result.research_type, 'market_research');
  });

  await testAsync('runOrchestratorContract: without researchParams, market_research reports an honest missing-input failure, never a fabricated result', async () => {
    const response = await runOrchestratorContract('run market research');
    const outputs = response.routing.plan[0].outputs;
    assert.strictEqual(outputs.status, 'failed');
    assert.strictEqual(outputs.result, null);
    assert.ok(outputs.error.includes('No structured research input was supplied'));
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
    const response = await runOrchestratorContract('keyword search visibility');
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
    const response = await runOrchestratorContract('keyword search visibility');
    assert.ok(Array.isArray(response.audit_trail));
    // Every field this file's other tests already assert on is still there, unchanged.
    assert.strictEqual(response.objective, 'keyword search visibility');
    assert.strictEqual(response.routing.status, 'planned');
    assert.deepStrictEqual(response.pending_approvals, []);
    assert.ok('growth_opportunity_drafts' in response);
    assert.ok('tokens_used' in response);
  });

  await testAsync('runOrchestratorContract: audit_trail on a clarification-required response records only the request/error event that actually happened', async () => {
    const emptyTaskResponse = await runOrchestratorContract('');
    assert.strictEqual(emptyTaskResponse.audit_trail.length, 1);
    assert.strictEqual(emptyTaskResponse.audit_trail[0].type, 'error');

    const ambiguousResponse = await runOrchestratorContract('I need content optimization help');
    assert.strictEqual(ambiguousResponse.audit_trail.length, 1);
    assert.strictEqual(ambiguousResponse.audit_trail[0].type, 'request');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();
