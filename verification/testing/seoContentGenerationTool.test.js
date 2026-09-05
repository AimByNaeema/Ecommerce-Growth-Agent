'use strict';

// Tests for the seo_content_generation tool (tools/seoContentGenerationTool.js) - the
// Information Gap Opportunity -> SEO Content Generation stage - and its wiring into the
// shared execution stack (permissions, provider selection, token/cost controls, audit).
//
// NO REAL MODEL CALL IS EVER MADE. BOTH provider clients are replaced on their shared,
// cached module objects for every test, so neither AI_PROVIDER value can reach a real
// API even if the local .env carries a live key. AI_PROVIDER is also pinned explicitly
// per test rather than inherited from the developer's environment.
//
// Every question, competitor, fact and draft below is an invented placeholder.

const assert = require('node:assert');

const claudeClient = require('../../agent/core/claudeClient');
const geminiClient = require('../../agent/core/geminiClient');
const { runSeoContentGenerationTool } = require('../../tools/seoContentGenerationTool');
const { findInformationGaps } = require('../../agent/core/informationGapEngine');
const { checkToolAccess, TOOL_CLASSIFICATIONS, SPECIALIST_ROLE_PERMISSIONS } = require('../../agent/core/toolPermissions');
const { getToolById } = require('../../tools/toolRegistry');
const { getCapabilityTask } = require('../../agent/core/specialistCapabilityRegistry');
const { createUsageTracker, checkUsageLimits } = require('../../agent/core/usageLimits');
const { getMaxTokensPerRun } = require('../../agent/core/tokenControls');
const orchestratorExecutionContract = require('../../agent/core/orchestratorExecutionContract');
const { createAuditTracker } = require('../../audit/auditTrail');
const { createUsageLedger } = require('../../usage/usageTracker');
const { createToolResultCache } = require('../../agent/core/toolResultCache');

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

const CLEAN_DRAFT =
  'How long an insulated jacket lasts depends on how often you wear it, how you store it, and how you wash it. With careful storage and gentle washing, a well-made insulated jacket stays warm and usable for a long time. Signs it needs replacing include flattened insulation that no longer lofts, and outer fabric that no longer sheds water.';

// Replaces BOTH clients so no configuration can produce a real call, and records which
// one the provider selector actually reached.
async function withMockedProviders({ provider = 'claude', text = CLEAN_DRAFT, throws = null }, fn) {
  const savedProvider = process.env.AI_PROVIDER;
  const savedClaude = claudeClient.sendMessage;
  const savedGemini = geminiClient.sendMessage;
  const savedClaudeKey = process.env.ANTHROPIC_API_KEY;
  const savedGeminiKey = process.env.GEMINI_API_KEY;

  process.env.AI_PROVIDER = provider;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-not-real';
  process.env.GEMINI_API_KEY = 'gemini-test-key-not-real';

  const hits = { claude: 0, gemini: 0 };
  claudeClient.sendMessage = async () => {
    hits.claude += 1;
    if (throws) throw new Error(throws);
    return { text, model: 'claude-sonnet-5', stopReason: 'end_turn', usage: { input_tokens: 120, output_tokens: 80 } };
  };
  geminiClient.sendMessage = async () => {
    hits.gemini += 1;
    if (throws) throw new Error(throws);
    return {
      text,
      model: 'gemini-2.5-flash',
      stopReason: 'STOP',
      usage: { promptTokenCount: 120, candidatesTokenCount: 80 },
    };
  };

  try {
    return await fn(hits);
  } finally {
    claudeClient.sendMessage = savedClaude;
    geminiClient.sendMessage = savedGemini;
    if (savedProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = savedProvider;
    if (savedClaudeKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedClaudeKey;
    if (savedGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedGeminiKey;
  }
}

function buildOpportunity(overrides = {}) {
  const { records } = findInformationGaps({
    questions: [
      {
        question: 'How long does an insulated jacket last?',
        questionType: 'buying',
        evidenceSources: [{ signalKind: 'competitor_faq', reference: '(placeholder FAQ reference)' }],
        competitorObservations: [
          { competitor: '(Example Co. A)', covered: false },
          { competitor: '(Example Co. B)', covered: false },
        ],
        productContext: '(Example insulated jacket)',
        ...overrides,
      },
    ],
  });
  return records[0];
}

(async () => {
  // --- Registration and permissions ----------------------------------------------

  test('the tool is registered under the existing conventions, as a write operation', () => {
    const tool = getToolById('seo_content_generation');
    assert.ok(tool, 'seo_content_generation is not in the tool registry');
    assert.strictEqual(tool.status, 'implemented');
    assert.strictEqual(tool.category, 'seo');
    // Authoring content is honestly a write - the registry defines 'read' as never
    // authoring new marketable content.
    assert.strictEqual(tool.operation, 'write');
  });

  test('permissions are enforced: SEO may author this, other specialists may not', () => {
    assert.strictEqual(checkToolAccess({ specialistId: 'seo', toolId: 'seo_content_generation' }).decision, 'allowed');
    for (const specialist of ['research', 'product', 'analytics_optimization']) {
      assert.strictEqual(
        checkToolAccess({ specialistId: specialist, toolId: 'seo_content_generation' }).decision,
        'denied',
        `${specialist} must not be able to author SEO content`
      );
    }
    // The smallest classification that fits: it publishes nothing.
    assert.strictEqual(TOOL_CLASSIFICATIONS.seo_content_generation, 'analysis_only');
  });

  test("SEO's widened role is still a real ceiling, not a blanket", () => {
    assert.deepStrictEqual(SPECIALIST_ROLE_PERMISSIONS.seo, ['read', 'write']);
    // It gained an operation, not new domains - SEO still cannot reach another
    // specialist's category.
    assert.strictEqual(checkToolAccess({ specialistId: 'seo', toolId: 'marketing_analysis' }).decision, 'denied');
    assert.strictEqual(checkToolAccess({ specialistId: 'seo', toolId: 'analytics_data_retrieval' }).decision, 'denied');
  });

  test('the capability declares the gap opportunity as its required input', () => {
    const task = getCapabilityTask('seo', 'seo_content_generation');
    assert.ok(task);
    assert.deepStrictEqual(task.tool_ids, ['seo_content_generation']);
    assert.deepStrictEqual(task.input_contract.required, ['opportunity']);
  });

  test('it counts against the run model-call budget', () => {
    const usageTracker = createUsageTracker();
    usageTracker.modelCalls = 999;
    const check = checkUsageLimits('seo_content_generation', usageTracker);
    assert.strictEqual(check.allowed, false);
    assert.strictEqual(check.limitType, 'model_calls');
  });

  // --- Gating: no fabricated content, and no wasted tokens ------------------------

  await testAsync('a valid opportunity produces a brief and a ready draft', async () => {
    await withMockedProviders({}, async () => {
      const outcome = await runSeoContentGenerationTool({ opportunity: buildOpportunity() });
      assert.strictEqual(outcome.status, 'success');
      assert.strictEqual(outcome.result.status, 'ready');
      assert.deepStrictEqual(outcome.result.review_reasons, []);
      assert.strictEqual(outcome.result.target_question, 'How long does an insulated jacket last?');
      assert.strictEqual(outcome.result.content_type, 'buying guide');
      assert.ok(outcome.result.generated_content.length > 0);
      assert.strictEqual(outcome.result.evidence.length, 1, 'provenance must carry through');
    });
  });

  await testAsync('a model-generated question is BLOCKED and costs no tokens at all', async () => {
    await withMockedProviders({}, async (hits) => {
      const outcome = await runSeoContentGenerationTool({ opportunity: buildOpportunity({ evidenceSources: [] }) });
      assert.strictEqual(outcome.status, 'blocked');
      assert.strictEqual(outcome.result.status, 'blocked');
      assert.strictEqual(outcome.result.generated_content, '', 'a blocked opportunity must produce no content');
      assert.ok(outcome.result.review_reasons[0].includes('no verified provenance'));
      // The whole point of gating first: no model was reached.
      assert.strictEqual(hits.claude + hits.gemini, 0);
      assert.strictEqual(outcome.tokensUsed, undefined);
    });
  });

  await testAsync('an opportunity our site already answers is BLOCKED', async () => {
    await withMockedProviders({}, async (hits) => {
      const outcome = await runSeoContentGenerationTool({
        opportunity: buildOpportunity({
          currentSiteCoverage: { covered: true, coverageQuality: 'complete', pages: ['(Example) /pages/jacket-care'] },
        }),
      });
      assert.strictEqual(outcome.status, 'blocked');
      assert.ok(outcome.result.review_reasons[0].includes('already answers this question'));
      assert.strictEqual(hits.claude + hits.gemini, 0);
    });
  });

  await testAsync('an unresolved opportunity yields a brief at REVIEW, with no generated content', async () => {
    await withMockedProviders({}, async (hits) => {
      // Only one competitor checked - the Gap Finder holds it at review.
      const outcome = await runSeoContentGenerationTool({
        opportunity: buildOpportunity({ competitorObservations: [{ competitor: '(Example Co. A)', covered: false }] }),
      });
      assert.strictEqual(outcome.status, 'partial');
      assert.strictEqual(outcome.result.status, 'review');
      assert.strictEqual(outcome.result.generated_content, '');
      assert.ok(outcome.result.review_reasons.length > 0);
      // A brief still exists for a human to act on.
      assert.strictEqual(outcome.result.brief.target_question, 'How long does an insulated jacket last?');
      assert.strictEqual(hits.claude + hits.gemini, 0, 'an unvalidated opportunity must not spend tokens');
    });
  });

  await testAsync('a missing opportunity fails honestly rather than inventing one', async () => {
    await withMockedProviders({}, async (hits) => {
      assert.strictEqual((await runSeoContentGenerationTool(undefined)).status, 'failed');
      assert.strictEqual((await runSeoContentGenerationTool({})).status, 'failed');
      assert.strictEqual(hits.claude + hits.gemini, 0);
    });
  });

  // --- Post-generation honesty checks ---------------------------------------------

  await testAsync('a draft that invents a figure is downgraded to REVIEW, never returned as ready', async () => {
    await withMockedProviders({ text: 'A quality insulated jacket lasts 5 years with proper care and storage.' }, async () => {
      const outcome = await runSeoContentGenerationTool({ opportunity: buildOpportunity() });
      assert.strictEqual(outcome.status, 'partial');
      assert.strictEqual(outcome.result.status, 'review');
      assert.ok(outcome.result.review_reasons.some((reason) => reason.includes('the figure 5 is not in the supplied evidence')));
      // The draft is still returned so a human can correct it - just never as ready.
      assert.ok(outcome.result.generated_content.includes('5 years'));
    });
  });

  await testAsync('a figure the caller established is accepted as ready', async () => {
    const draft =
      'How long an insulated jacket lasts depends on wear, storage and washing. Our insulated jackets carry a 3 year warranty against defects, and with care they stay usable well beyond it.';
    await withMockedProviders({ text: draft }, async () => {
      const outcome = await runSeoContentGenerationTool({
        opportunity: buildOpportunity(),
        supportedFacts: ['Our insulated jackets carry a 3 year warranty against defects (placeholder).'],
      });
      assert.strictEqual(outcome.result.status, 'ready');
    });
  });

  await testAsync('a draft reproducing competitor wording is downgraded to REVIEW', async () => {
    const competitorText = 'Store your insulated jacket loosely in a breathable garment bag away from direct sunlight always';
    await withMockedProviders({ text: `To protect it, store your insulated jacket loosely in a breathable garment bag away from direct sunlight always.` }, async () => {
      const outcome = await runSeoContentGenerationTool({
        opportunity: buildOpportunity(),
        competitorTexts: [competitorText],
      });
      assert.strictEqual(outcome.result.status, 'review');
      assert.ok(outcome.result.review_reasons.some((reason) => reason.includes('reproduces competitor wording')));
    });
  });

  await testAsync('a draft leaving verification markers is downgraded to REVIEW', async () => {
    await withMockedProviders({ text: 'An insulated jacket typically lasts [VERIFY: typical lifespan] with normal use and care.' }, async () => {
      const outcome = await runSeoContentGenerationTool({ opportunity: buildOpportunity() });
      assert.strictEqual(outcome.result.status, 'review');
      assert.ok(outcome.result.review_reasons.some((reason) => reason.includes('needs a fact it was not given')));
    });
  });

  await testAsync('a draft inventing demand or ranking data is downgraded to REVIEW', async () => {
    await withMockedProviders({ text: 'This is one of our most-asked questions, with 12,000 monthly searches, and we rank #1 for it.' }, async () => {
      const outcome = await runSeoContentGenerationTool({ opportunity: buildOpportunity() });
      assert.strictEqual(outcome.result.status, 'review');
      assert.ok(outcome.result.review_reasons.some((reason) => reason.includes('Fabricated performance/demand claim')));
    });
  });

  await testAsync('the generated content addresses the target question', async () => {
    await withMockedProviders({}, async () => {
      const outcome = await runSeoContentGenerationTool({ opportunity: buildOpportunity() });
      const content = outcome.result.generated_content.toLowerCase();
      for (const term of ['insulated', 'jacket', 'last']) {
        assert.ok(content.includes(term), `the draft should address "${term}"`);
      }
    });
  });

  await testAsync('the model is never shown competitor text or identities', async () => {
    const savedProvider = process.env.AI_PROVIDER;
    process.env.AI_PROVIDER = 'claude';
    const savedSend = claudeClient.sendMessage;
    const savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-not-real';
    let sentContent = '';
    claudeClient.sendMessage = async (request) => {
      sentContent = request.messages[0].content;
      return { text: CLEAN_DRAFT, model: 'claude-sonnet-5', stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
    };
    try {
      await runSeoContentGenerationTool({
        opportunity: buildOpportunity(),
        competitorTexts: ['ZZQUUX_COMPETITOR_PROPRIETARY_TEXT about storing jackets in garment bags'],
      });
      assert.ok(!sentContent.includes('ZZQUUX_COMPETITOR_PROPRIETARY_TEXT'), 'competitor text reached the model');
      assert.ok(!sentContent.includes('Example Co.'), 'a competitor identity reached the model');
      assert.ok(sentContent.includes('How long does an insulated jacket last?'));
    } finally {
      claudeClient.sendMessage = savedSend;
      if (savedProvider === undefined) delete process.env.AI_PROVIDER;
      else process.env.AI_PROVIDER = savedProvider;
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });

  // --- Provider selection and cost controls ---------------------------------------

  await testAsync('AI_PROVIDER decides which client answers - neither is hardcoded', async () => {
    await withMockedProviders({ provider: 'gemini' }, async (hits) => {
      await runSeoContentGenerationTool({ opportunity: buildOpportunity() });
      assert.strictEqual(hits.gemini, 1);
      assert.strictEqual(hits.claude, 0);
    });
    await withMockedProviders({ provider: 'claude' }, async (hits) => {
      await runSeoContentGenerationTool({ opportunity: buildOpportunity() });
      assert.strictEqual(hits.claude, 1);
      assert.strictEqual(hits.gemini, 0);
    });
  });

  await testAsync('token usage is reported for both providers\' usage shapes', async () => {
    for (const provider of ['claude', 'gemini']) {
      await withMockedProviders({ provider }, async () => {
        const outcome = await runSeoContentGenerationTool({ opportunity: buildOpportunity() });
        assert.strictEqual(outcome.tokensUsed, 200, `${provider} usage must be counted`);
        assert.strictEqual(outcome.inputTokens, 120);
        assert.strictEqual(outcome.outputTokens, 80);
      });
    }
  });

  await testAsync('an exhausted run token budget refuses before any model call', async () => {
    await withMockedProviders({}, async (hits) => {
      const outcome = await runSeoContentGenerationTool({
        opportunity: buildOpportunity(),
        tokensUsedThisRun: getMaxTokensPerRun(),
      });
      assert.strictEqual(outcome.status, 'failed');
      assert.strictEqual(hits.claude + hits.gemini, 0);
    });
  });

  await testAsync('a provider failure is reported honestly, never replaced with a draft', async () => {
    await withMockedProviders({ throws: 'provider unavailable (placeholder)' }, async () => {
      const outcome = await runSeoContentGenerationTool({ opportunity: buildOpportunity() });
      assert.strictEqual(outcome.status, 'failed');
      assert.strictEqual(outcome.result, null);
      assert.ok(outcome.error.includes('provider unavailable'));
    });
  });

  // --- Shared execution stack: audit, usage, and no publishing --------------------

  await testAsync('running through buildPlanStep enforces permissions and records audit + usage', async () => {
    await withMockedProviders({}, async () => {
      const runAuditTracker = createAuditTracker('content-generation-test-run', null);
      const runUsageLedger = createUsageLedger('content-generation-test-run', null);
      const runTokenTracker = { tokensUsedThisRun: 0 };
      const runUsageTracker = createUsageTracker();

      const step = await orchestratorExecutionContract.buildPlanStep(
        orchestratorExecutionContract.buildSpecialistTarget('seo'),
        'Write content answering the identified information gap.',
        'Write content answering the identified information gap.',
        runTokenTracker,
        { opportunity: buildOpportunity() },
        [],
        { requests: [] },
        runAuditTracker,
        createToolResultCache(),
        runUsageTracker,
        null,
        runUsageLedger,
        { toolId: 'seo_content_generation', capabilityId: 'seo_content_generation' }
      );

      assert.strictEqual(step.inputs.tool_id, 'seo_content_generation');
      assert.strictEqual(step.completion_state, 'complete');
      assert.strictEqual(step.outputs.result.status, 'ready');

      const auditTypes = runAuditTracker.events.map((event) => event.type);
      assert.ok(auditTypes.includes('tools'));
      assert.ok(auditTypes.includes('execution'));

      // Real model tokens counted against the run's shared budget and ledger.
      assert.strictEqual(runTokenTracker.tokensUsedThisRun, 200);
      assert.strictEqual(runUsageTracker.modelCalls, 1);
      assert.ok(runUsageLedger.events.some((event) => event.category === 'model_call'));
    });
  });

  test('the tool imports nothing that could publish, send, or schedule', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'seoContentGenerationTool.js'), 'utf8');
    // Checked against CODE only - the file's comments legitimately discuss publishing in
    // order to state that it does none, and matching that prose would assert the
    // opposite of what this test is for.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
      .join('\n');
    // Capability, not vocabulary: the file's limitations text legitimately contains the
    // word "publish" in order to tell a reader that nothing is published. What matters
    // is that it imports and calls nothing that COULD publish, send, or schedule.
    // The module proper, excluding its `require.main` demo block (which legitimately
    // builds a sample opportunity via the Gap Finder to demonstrate the flow).
    const moduleProper = code.split('require.main === module')[0];
    const requires = [...moduleProper.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((match) => match[1]);
    assert.deepStrictEqual(
      requires.sort(),
      ['../agent/core/contentBriefEngine', '../agent/core/contentBriefModel', './aiReasoningCompletion'].sort(),
      'the content generator must import only the shared model path and its own engine/schema'
    );
    for (const forbidden of ['shopifyClient', 'integrations/', 'node:http', 'node:fs', 'fetch(']) {
      assert.ok(!code.includes(forbidden), `the content generator must not reference ${forbidden}`);
    }
    // The only external reach is the shared model path - no client of its own.
    assert.ok(code.includes("require('./aiReasoningCompletion')"));
    for (const forbidden of ['claudeClient', 'geminiClient', 'aiProviderSelector']) {
      assert.ok(!code.includes(forbidden), `the content generator must not require ${forbidden} directly`);
    }
  });

  await testAsync('a ready result carries no publishing side effect or destination', async () => {
    await withMockedProviders({}, async () => {
      const outcome = await runSeoContentGenerationTool({ opportunity: buildOpportunity() });
      const keys = Object.keys(outcome.result);
      for (const forbidden of ['published', 'publish_at', 'destination', 'schedule', 'channel', 'url']) {
        assert.ok(!keys.includes(forbidden), `the result must not carry ${forbidden}`);
      }
      // target_page is intent only, and stays exactly what the opportunity carried.
      assert.strictEqual(outcome.result.target_page, buildOpportunity().recommended_target_page);
      assert.ok(outcome.result.limitations.some((limitation) => limitation.includes('nothing here is published')));
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
