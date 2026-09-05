'use strict';

// Tests for the discover_market_questions tool (tools/marketQuestionDiscoveryTool.js) -
// the one place this capability touches the outside world - plus its wiring into the
// shared execution stack (permissions, token/usage controls, audit).
//
// NO REAL EXTERNAL CALL IS EVER MADE. claudeClient.sendMessage and isConfigured are
// replaced on the shared, cached module object for every test that would otherwise reach
// the network, and each mock is installed and restored inside one test's try/finally so
// none leaks. The tool reaches claudeClient DIRECTLY (not through aiProviderSelector -
// it needs Anthropic's hosted web_search tool, which the Gemini client has no equivalent
// for), so mocking that module is sufficient and no AI_PROVIDER pinning is required.
//
// Every question, URL and topic below is an invented placeholder for testing.

const assert = require('node:assert');
const claudeClient = require('../../agent/core/claudeClient');
const { runMarketQuestionDiscoveryTool } = require('../../tools/marketQuestionDiscoveryTool');
const { checkToolAccess, TOOL_CLASSIFICATIONS } = require('../../agent/core/toolPermissions');
const { getToolById } = require('../../tools/toolRegistry');
const { getCapabilityTask } = require('../../agent/core/specialistCapabilityRegistry');
const { createUsageTracker, checkUsageLimits } = require('../../agent/core/usageLimits');
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

const FAQ_URL = 'https://example.com/faq';
const FORUM_URL = 'https://forum.example.com/thread/1';

// A response shaped like a real web_search-backed reply: a narration text block, the
// web_search_tool_result block the URLs are verified against, then the model's final
// structured answer.
function buildResponse({ returnedUrls = [FAQ_URL], questions = [], finalText, stopReason = 'end_turn' } = {}) {
  const answer =
    finalText !== undefined ? finalText : JSON.stringify({ topic: 'jacket care', questions });
  return {
    text: answer,
    model: 'claude-sonnet-5',
    stopReason,
    usage: { input_tokens: 120, output_tokens: 80 },
    raw: {
      content: [
        { type: 'text', text: "I'll search for real questions about this topic..." },
        {
          type: 'web_search_tool_result',
          content: returnedUrls.map((url) => ({ type: 'web_search_result', url })),
        },
        { type: 'text', text: answer },
      ],
    },
  };
}

// Replaces the two claudeClient entry points this tool uses, always restoring them.
async function withMockedClaude({ response, sendMessage, configured = true }, fn) {
  const savedSend = claudeClient.sendMessage;
  const savedConfigured = claudeClient.isConfigured;
  const calls = [];
  claudeClient.isConfigured = () => configured;
  claudeClient.sendMessage = async (request) => {
    calls.push(request);
    if (sendMessage) return sendMessage(request);
    return response;
  };
  try {
    return await fn(calls);
  } finally {
    claudeClient.sendMessage = savedSend;
    claudeClient.isConfigured = savedConfigured;
  }
}

(async () => {
  // --- Registration through the shared infrastructure ----------------------------

  test('the tool is registered in toolRegistry.js under the existing conventions', () => {
    const tool = getToolById('discover_market_questions');
    assert.ok(tool, 'discover_market_questions is not in the tool registry');
    assert.strictEqual(tool.status, 'implemented');
    assert.strictEqual(tool.operation, 'read');
    assert.strictEqual(tool.category, 'seo');
  });

  test('permissions govern it - the SEO specialist may use it, others may not', () => {
    assert.strictEqual(checkToolAccess({ specialistId: 'seo', toolId: 'discover_market_questions' }).decision, 'allowed');
    assert.strictEqual(checkToolAccess({ specialistId: 'marketing', toolId: 'discover_market_questions' }).decision, 'denied');
    // Classified like live_competitor_research: it retrieves and composes, never writes.
    assert.strictEqual(TOOL_CLASSIFICATIONS.discover_market_questions, 'analysis_only');
  });

  test('discovery is its own capability, because its required input is a topic not questions', () => {
    const discovery = getCapabilityTask('seo', 'market_question_discovery');
    assert.ok(discovery, 'market_question_discovery is missing from the SEO capability registry');
    assert.deepStrictEqual(discovery.tool_ids, ['discover_market_questions']);
    assert.deepStrictEqual(discovery.input_contract.required, ['topic']);
    // Deliberately null, for the same reason competitor_research documents - otherwise
    // this would become a fallback live source for unrelated SEO tasks.
    assert.strictEqual(discovery.live_data_tool_id, null);

    // And the analysis capability it feeds is left exactly as it was.
    const analysis = getCapabilityTask('seo', 'information_gap_analysis');
    assert.deepStrictEqual(analysis.tool_ids, ['seo_analysis']);
    assert.ok(analysis.input_contract.required.includes('questions'));
  });

  test('it counts against the run model-call budget, like every other model call', () => {
    const usageTracker = createUsageTracker();
    usageTracker.modelCalls = 999;
    const check = checkUsageLimits('discover_market_questions', usageTracker);
    assert.strictEqual(check.allowed, false);
    assert.strictEqual(check.limitType, 'model_calls');
  });

  // --- Fail-safe behavior (no external call reached) ------------------------------

  await testAsync('a missing topic fails safely without ever calling the API', async () => {
    let called = 0;
    await withMockedClaude({ sendMessage: async () => { called += 1; return buildResponse(); } }, async () => {
      const outcome = await runMarketQuestionDiscoveryTool({});
      assert.strictEqual(outcome.status, 'failed');
      assert.ok(outcome.error.includes('topic'));
      assert.strictEqual(called, 0);
      // No usage fields, because no call was made and nothing was spent.
      assert.strictEqual(outcome.tokensUsed, undefined);
    });
  });

  await testAsync('an unconfigured API key fails safely and names the fix', async () => {
    await withMockedClaude({ configured: false, response: buildResponse() }, async () => {
      const outcome = await runMarketQuestionDiscoveryTool({ topic: 'jacket care' });
      assert.strictEqual(outcome.status, 'failed');
      assert.ok(outcome.error.includes('ANTHROPIC_API_KEY'));
    });
  });

  await testAsync('an exhausted run token budget refuses before any API call', async () => {
    let called = 0;
    await withMockedClaude({ sendMessage: async () => { called += 1; return buildResponse(); } }, async () => {
      const outcome = await runMarketQuestionDiscoveryTool({ topic: 'jacket care', tokensUsedThisRun: 100000000 });
      assert.strictEqual(outcome.status, 'failed');
      assert.strictEqual(called, 0, 'the token budget must be checked before spending anything');
    });
  });

  await testAsync('a thrown API error fails safely rather than propagating', async () => {
    await withMockedClaude({ sendMessage: async () => { throw new Error('network unavailable (placeholder)'); } }, async () => {
      const outcome = await runMarketQuestionDiscoveryTool({ topic: 'jacket care' });
      assert.strictEqual(outcome.status, 'failed');
      assert.strictEqual(outcome.result, null);
      assert.ok(outcome.error.includes('network unavailable'));
    });
  });

  await testAsync('a search that returns nothing reports empty, never an invented question', async () => {
    await withMockedClaude(
      {
        response: buildResponse({
          returnedUrls: [],
          questions: [{ question: 'A question with no search behind it?', evidenceKind: 'public_qa', sourceUrl: FAQ_URL }],
        }),
      },
      async () => {
        const outcome = await runMarketQuestionDiscoveryTool({ topic: 'jacket care' });
        assert.strictEqual(outcome.status, 'empty');
        assert.strictEqual(outcome.result, null);
        // Real tokens were still spent, so usage is still reported honestly.
        assert.strictEqual(outcome.tokensUsed, 200);
      }
    );
  });

  await testAsync('an unparseable reply fails honestly, and a truncated one says so specifically', async () => {
    await withMockedClaude({ response: buildResponse({ finalText: 'not json at all' }) }, async () => {
      const outcome = await runMarketQuestionDiscoveryTool({ topic: 'jacket care' });
      assert.strictEqual(outcome.status, 'failed');
      assert.ok(outcome.error.includes('did not return structured question data'));
    });

    await withMockedClaude({ response: buildResponse({ finalText: '{"questions": [', stopReason: 'max_tokens' }) }, async () => {
      const outcome = await runMarketQuestionDiscoveryTool({ topic: 'jacket care' });
      assert.strictEqual(outcome.status, 'failed');
      assert.ok(outcome.error.includes('MAX_TOKENS_PER_CALL'));
    });
  });

  // --- Provenance verification end to end ----------------------------------------

  await testAsync('a verified question becomes evidence, ready for the Gap Finder', async () => {
    await withMockedClaude(
      {
        response: buildResponse({
          returnedUrls: [FAQ_URL, FORUM_URL],
          questions: [
            { question: 'How long does an insulated jacket last?', evidenceKind: 'competitor_question', sourceUrl: FAQ_URL, originalObservation: 'in the FAQ list' },
            { question: 'how long does an insulated jacket last', evidenceKind: 'public_forum_question', sourceUrl: FORUM_URL },
          ],
        }),
      },
      async () => {
        const outcome = await runMarketQuestionDiscoveryTool({ topic: 'jacket care', market: 'EU' });
        assert.strictEqual(outcome.status, 'success');
        assert.strictEqual(outcome.result.questions.length, 1, 'the duplicate must merge');
        assert.strictEqual(outcome.result.questions[0].observation_count, 2, 'both sources must be preserved');
        assert.strictEqual(outcome.result.questions[0].evidence_strength, 'observed');
        assert.strictEqual(outcome.result.demand_measured, false);
        assert.strictEqual(outcome.result.verified_source_count, 2);
        // Handed over in the Gap Finder's own input shape, no translation needed.
        assert.strictEqual(outcome.result.gap_finder_input[0].evidenceSources.length, 2);
      }
    );
  });

  await testAsync('a fabricated source URL cannot survive - the whole point of the layer', async () => {
    await withMockedClaude(
      {
        response: buildResponse({
          returnedUrls: [FAQ_URL],
          questions: [
            { question: 'A real one?', evidenceKind: 'public_qa', sourceUrl: FAQ_URL },
            // The model citing a URL the search never returned.
            { question: 'An invented one?', evidenceKind: 'public_qa', sourceUrl: 'https://fabricated.example.com/nope' },
          ],
        }),
      },
      async () => {
        const outcome = await runMarketQuestionDiscoveryTool({ topic: 'jacket care' });
        assert.strictEqual(outcome.status, 'partial', 'some but not all verified');

        const invented = outcome.result.questions.find((record) => record.question === 'An invented one?');
        assert.strictEqual(invented.evidence_strength, 'model_generated');
        assert.strictEqual(invented.observation_count, 0);
        // The false citation is gone entirely.
        assert.ok(!JSON.stringify(outcome.result).includes('fabricated.example.com'));

        // And it reaches the Gap Finder carrying no evidence at all.
        const inventedInput = outcome.result.gap_finder_input.find((entry) => entry.question === 'An invented one?');
        assert.deepStrictEqual(inventedInput.evidenceSources, []);
      }
    );
  });

  await testAsync('when nothing verifies at all, the tool reports empty rather than a result', async () => {
    await withMockedClaude(
      {
        response: buildResponse({
          returnedUrls: [FAQ_URL],
          questions: [{ question: 'All invented?', evidenceKind: 'public_qa', sourceUrl: 'https://fabricated.example.com/x' }],
        }),
      },
      async () => {
        const outcome = await runMarketQuestionDiscoveryTool({ topic: 'jacket care' });
        assert.strictEqual(outcome.status, 'empty');
        assert.strictEqual(outcome.result, null);
        assert.ok(outcome.error.includes('could be verified against real web search results'));
      }
    );
  });

  await testAsync('the requested result limit bounds what the model is asked for and what is returned', async () => {
    const questions = [];
    for (let i = 0; i < 10; i += 1) {
      questions.push({ question: `Distinct question ${i}?`, evidenceKind: 'public_qa', sourceUrl: FAQ_URL });
    }
    await withMockedClaude({ response: buildResponse({ questions }) }, async (calls) => {
      const outcome = await runMarketQuestionDiscoveryTool({ topic: 'jacket care', limit: 3 });
      assert.strictEqual(outcome.result.questions.length, 3);
      // The bound is also communicated to the model, so it does not do more work than needed.
      assert.ok(calls[0].system.includes('at most 3 questions'));
    });

    // A caller cannot request an unbounded crawl.
    await withMockedClaude({ response: buildResponse({ questions }) }, async (calls) => {
      await runMarketQuestionDiscoveryTool({ topic: 'jacket care', limit: 100000 });
      assert.ok(calls[0].system.includes('at most 50 questions'));
    });
  });

  await testAsync('unsupported sources are reported on every successful result', async () => {
    await withMockedClaude(
      { response: buildResponse({ questions: [{ question: 'A real one?', evidenceKind: 'public_qa', sourceUrl: FAQ_URL }] }) },
      async () => {
        const outcome = await runMarketQuestionDiscoveryTool({ topic: 'jacket care' });
        const kinds = outcome.result.unsupported_sources.map((entry) => entry.evidence_kind);
        assert.ok(kinds.includes('search_suggestion'));
        assert.ok(kinds.includes('people_also_ask'));
        assert.ok(kinds.includes('related_search'));
      }
    );
  });

  await testAsync('the prompt forbids copied content, personal data and invented demand', async () => {
    await withMockedClaude({ response: buildResponse({ questions: [] }) }, async (calls) => {
      await runMarketQuestionDiscoveryTool({ topic: 'jacket care' });
      const system = calls[0].system;
      assert.ok(system.includes('Do NOT copy page content'));
      assert.ok(system.includes('personal information'));
      assert.ok(system.includes('must not estimate it'));
      // And it really does use the project's existing web_search passthrough.
      assert.strictEqual(calls[0].tools[0].name, 'web_search');
    });
  });

  // --- Shared execution stack: permissions, cost and audit ------------------------

  await testAsync('running through buildPlanStep enforces permissions and records audit + usage', async () => {
    await withMockedClaude(
      {
        response: buildResponse({
          questions: [{ question: 'How long does it last?', evidenceKind: 'competitor_question', sourceUrl: FAQ_URL }],
        }),
      },
      async () => {
        const runAuditTracker = createAuditTracker('discovery-test-run', null);
        const runUsageLedger = createUsageLedger('discovery-test-run', null);
        const runTokenTracker = { tokensUsedThisRun: 0 };
        const runUsageTracker = createUsageTracker();

        const step = await orchestratorExecutionContract.buildPlanStep(
          orchestratorExecutionContract.buildSpecialistTarget('seo'),
          'Discover real market questions about jacket care.',
          'Discover real market questions about jacket care.',
          runTokenTracker,
          { topic: 'jacket care', limit: 5 },
          [],
          { requests: [] },
          runAuditTracker,
          createToolResultCache(),
          runUsageTracker,
          null,
          runUsageLedger,
          { toolId: 'discover_market_questions', capabilityId: 'market_question_discovery' }
        );

        assert.strictEqual(step.inputs.tool_id, 'discover_market_questions');
        assert.deepStrictEqual(step.tool_calls, ['discover_market_questions']);
        assert.strictEqual(step.completion_state, 'complete');
        assert.strictEqual(step.outputs.result.questions[0].evidence_strength, 'observed');

        // Audit recorded it exactly like any other tool call.
        const auditTypes = runAuditTracker.events.map((event) => event.type);
        assert.ok(auditTypes.includes('tools'));
        assert.ok(auditTypes.includes('execution'));

        // Real model tokens were counted against the run's shared budget and ledger -
        // this tool must never spend silently.
        assert.strictEqual(runTokenTracker.tokensUsedThisRun, 200);
        assert.strictEqual(runUsageTracker.modelCalls, 1);
        assert.strictEqual(runUsageTracker.toolCalls, 1);
        assert.ok(runUsageLedger.events.some((event) => event.category === 'model_call'));
      }
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
