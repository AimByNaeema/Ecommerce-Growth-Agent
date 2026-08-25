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
  validateResult,
  splitIntoClauses,
  routeClause,
  planRouting,
  runOrchestratorContract,
} = require('../../agent/core/orchestratorExecutionContract');
const claudeClient = require('../../agent/core/claudeClient');
const { getMaxTokensPerRun } = require('../../agent/core/tokenControls');

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
    // keyword_research is implemented, but no research_params were supplied for this
    // free-text-only call - the tool itself reports that honestly (never a fabricated
    // result) rather than the orchestrator finding it not_available, the same pattern
    // as the 'without researchParams' market_research case below.
    assert.strictEqual(step.completion_state, 'complete');
    assert.strictEqual(step.outputs.status, 'failed');
    assert.strictEqual(step.outputs.result, null);
    assert.ok(step.outputs.error.includes('No structured research input was supplied'));
  });

  await testAsync('runOrchestratorContract: a clean single-specialist task (Listing) produces a one-step plan of shared execution state', async () => {
    const response = await runOrchestratorContract('improve my listing content');
    assert.strictEqual(response.needs_more_information, false);
    assert.strictEqual(response.routing.status, 'planned');
    assert.strictEqual(response.routing.plan.length, 1);
    const step = response.routing.plan[0];
    assert.strictEqual(step.selected_specialist.id, 'listing');
    assert.deepStrictEqual(step.tool_calls, ['listing_content_generation']);
    // listing_content_generation is implemented, but no research_params were supplied
    // for this free-text-only call - the tool itself reports that honestly (never a
    // fabricated result) rather than the orchestrator finding it not_available, the
    // same pattern as the SEO/market_research 'without researchParams' cases.
    assert.strictEqual(step.completion_state, 'complete');
    assert.strictEqual(step.outputs.status, 'failed');
    assert.strictEqual(step.outputs.result, null);
    assert.ok(step.outputs.error.includes('No structured research input was supplied'));
  });

  await testAsync('runOrchestratorContract: a clean single-specialist task (Marketing) produces a one-step plan of shared execution state', async () => {
    const response = await runOrchestratorContract('marketing campaign strategy');
    assert.strictEqual(response.needs_more_information, false);
    assert.strictEqual(response.routing.status, 'planned');
    assert.strictEqual(response.routing.plan.length, 1);
    const step = response.routing.plan[0];
    assert.strictEqual(step.selected_specialist.id, 'marketing');
    assert.deepStrictEqual(step.tool_calls, ['marketing_analysis']);
    // marketing_analysis is implemented, but no research_params were supplied for this
    // free-text-only call - the tool itself reports that honestly (never a fabricated
    // result), the same pattern as the SEO/Listing/market_research 'without
    // researchParams' cases.
    assert.strictEqual(step.completion_state, 'complete');
    assert.strictEqual(step.outputs.status, 'failed');
    assert.strictEqual(step.outputs.result, null);
    assert.ok(step.outputs.error.includes('No structured research input was supplied'));
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
    // clause's own wording ("social", "media"), but no research_params were supplied
    // for this free-text-only call - the tool itself reports that honestly (never a
    // fabricated result), the same pattern as the SEO/Listing/Marketing/market_research
    // 'without researchParams' cases.
    assert.deepStrictEqual(socialStep.tool_calls, ['social_content_planning']);
    assert.strictEqual(socialStep.completion_state, 'complete');
    assert.strictEqual(socialStep.outputs.status, 'failed');
    assert.strictEqual(socialStep.outputs.result, null);
    assert.ok(socialStep.outputs.error.includes('No structured research input was supplied'));
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

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();
