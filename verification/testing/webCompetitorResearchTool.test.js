'use strict';

const assert = require('node:assert');
const { runWebCompetitorResearchTool } = require('../../tools/webCompetitorResearchTool');
const claudeClient = require('../../agent/core/claudeClient');
const { getMaxTokensPerRun } = require('../../agent/core/tokenControls');

// webCompetitorResearchTool.js calls claudeClient.sendMessage(...) via the required
// module object (not a destructured binding), which is what makes it possible to
// substitute a mocked implementation here without a mocking framework - see that
// file's header comment and verification/testing/aiReasoningCompletion.test.js's
// identical convention. Every mock is installed and restored within a single test's
// try/finally so no mock ever leaks into another test.

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

function withApiKeyConfigured(fn) {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-not-real';
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    });
}

// Builds a mocked claudeClient.sendMessage response shaped like a real Messages API
// reply that actually used the web_search tool - one web_search_tool_result block
// (the ground truth of what was really searched) plus one text block whose content is
// the model's own structured-JSON reply.
function mockedSearchResponse({ foundUrls, replyJson }) {
  return {
    text: JSON.stringify(replyJson),
    model: 'claude-sonnet-5',
    stopReason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 200 },
    raw: {
      content: [
        { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'q' } },
        {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_1',
          content: foundUrls.map((url, i) => ({ type: 'web_search_result', url, title: `Result ${i}` })),
        },
        { type: 'text', text: JSON.stringify(replyJson), citations: [] },
      ],
    },
  };
}

test('exports the expected function', () => {
  assert.strictEqual(typeof runWebCompetitorResearchTool, 'function');
});

(async () => {
  await testAsync('rejects a missing/empty objective without touching Claude at all', async () => {
    const originalSendMessage = claudeClient.sendMessage;
    claudeClient.sendMessage = async () => {
      throw new Error('sendMessage should never be called for an invalid objective');
    };
    try {
      const missing = await runWebCompetitorResearchTool({});
      assert.strictEqual(missing.status, 'failed');
      assert.ok(/non-empty objective/.test(missing.error));

      const blank = await runWebCompetitorResearchTool({ objective: '   ' });
      assert.strictEqual(blank.status, 'failed');
    } finally {
      claudeClient.sendMessage = originalSendMessage;
    }
  });

  await testAsync('throws no exception and reports a clear not-configured failure when ANTHROPIC_API_KEY is unset (real claudeClient, no mock)', async () => {
    claudeClient.loadEnvOnce();
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const outcome = await runWebCompetitorResearchTool({ objective: 'Find my top competitors.' });
      assert.strictEqual(outcome.status, 'failed');
      assert.ok(/ANTHROPIC_API_KEY is not set/.test(outcome.error));
    } finally {
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });

  await testAsync('refuses to call Claude at all once this run\'s shared token budget is exhausted', async () => {
    const originalSendMessage = claudeClient.sendMessage;
    claudeClient.sendMessage = async () => {
      throw new Error('sendMessage should never be called once the run budget is exhausted');
    };
    try {
      await withApiKeyConfigured(async () => {
        const outcome = await runWebCompetitorResearchTool({
          objective: 'Find my top competitors.',
          tokensUsedThisRun: getMaxTokensPerRun(),
        });
        assert.strictEqual(outcome.status, 'failed');
        assert.ok(/budget/.test(outcome.error));
      });
    } finally {
      claudeClient.sendMessage = originalSendMessage;
    }
  });

  await testAsync('MOCKED: reports the underlying error, never a fabricated result, when the Claude API call itself fails', async () => {
    const originalSendMessage = claudeClient.sendMessage;
    claudeClient.sendMessage = async () => {
      throw new Error('Claude API request failed (500): Internal error');
    };
    try {
      await withApiKeyConfigured(async () => {
        const outcome = await runWebCompetitorResearchTool({ objective: 'Find my top competitors.' });
        assert.strictEqual(outcome.status, 'failed');
        assert.ok(/Internal error/.test(outcome.error));
        assert.strictEqual(outcome.result, null);
      });
    } finally {
      claudeClient.sendMessage = originalSendMessage;
    }
  });

  await testAsync('MOCKED: reports status "empty" (never fabricates) when the web search returned no real results at all', async () => {
    const originalSendMessage = claudeClient.sendMessage;
    claudeClient.sendMessage = async () =>
      mockedSearchResponse({ foundUrls: [], replyJson: { competitors: [] } });
    try {
      await withApiKeyConfigured(async () => {
        const outcome = await runWebCompetitorResearchTool({ objective: 'Find my top competitors.' });
        assert.strictEqual(outcome.status, 'empty');
        assert.strictEqual(outcome.result, null);
      });
    } finally {
      claudeClient.sendMessage = originalSendMessage;
    }
  });

  await testAsync('MOCKED: reports status "failed" when the model reply is not valid structured JSON', async () => {
    const originalSendMessage = claudeClient.sendMessage;
    claudeClient.sendMessage = async () => ({
      text: 'Sure, here are some competitors: Acme Co, Beta Co.',
      model: 'claude-sonnet-5',
      stopReason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 10 },
      raw: {
        content: [
          {
            type: 'web_search_tool_result',
            tool_use_id: 'x',
            content: [{ type: 'web_search_result', url: 'https://example.com/a' }],
          },
          { type: 'text', text: 'Sure, here are some competitors: Acme Co, Beta Co.' },
        ],
      },
    });
    try {
      await withApiKeyConfigured(async () => {
        const outcome = await runWebCompetitorResearchTool({ objective: 'Find my top competitors.' });
        assert.strictEqual(outcome.status, 'failed');
        assert.ok(/structured competitor data/.test(outcome.error));
      });
    } finally {
      claudeClient.sendMessage = originalSendMessage;
    }
  });

  await testAsync('MOCKED: drops a claimed competitor whose source URL was never actually returned by web_search - never trusts the model\'s self-report', async () => {
    const originalSendMessage = claudeClient.sendMessage;
    claudeClient.sendMessage = async () =>
      mockedSearchResponse({
        foundUrls: ['https://real-search-result.example/acme'],
        replyJson: {
          topic: 'Handmade candle competitors',
          competitors: [
            {
              competitor: 'Invented Co.',
              market: 'US',
              productCategory: 'candles',
              positioning: 'premium',
              pricingEvidence: ['$40 per candle'],
              strengths: ['strong brand'],
              weaknesses: [],
              marketingSignals: [],
              seoSignals: [],
              opportunities: [],
              // A URL the model claims but that web_search never actually returned -
              // must never be trusted.
              source: ['https://a-url-search-never-returned.example/invented'],
            },
          ],
        },
      });
    try {
      await withApiKeyConfigured(async () => {
        const outcome = await runWebCompetitorResearchTool({ objective: 'Find my top competitors.' });
        assert.strictEqual(outcome.status, 'empty');
        assert.strictEqual(outcome.result, null);
        assert.ok(/could be verified/.test(outcome.error));
      });
    } finally {
      claudeClient.sendMessage = originalSendMessage;
    }
  });

  await testAsync('MOCKED: a verified competitor (source URL actually returned by web_search) produces a real, composed competitor_research result', async () => {
    const originalSendMessage = claudeClient.sendMessage;
    let receivedRequest = null;
    claudeClient.sendMessage = async (request) => {
      receivedRequest = request;
      return mockedSearchResponse({
        foundUrls: ['https://real-search-result.example/acme-candles'],
        replyJson: {
          topic: 'Handmade candle competitors',
          competitors: [
            {
              competitor: 'Acme Candles',
              market: 'United States',
              productCategory: 'handmade candles',
              positioning: 'premium, small-batch',
              pricingEvidence: ['$32 for a 3-wick candle'],
              strengths: ['strong Instagram following'],
              weaknesses: ['limited scent range'],
              marketingSignals: ['weekly Instagram Reels'],
              seoSignals: ['ranks for "handmade soy candles"'],
              opportunities: ['no subscription offering yet'],
              source: ['https://real-search-result.example/acme-candles'],
            },
          ],
          recommendations: ['Consider a subscription offering, which Acme Candles lacks.'],
        },
      });
    };
    try {
      await withApiKeyConfigured(async () => {
        const outcome = await runWebCompetitorResearchTool({ objective: 'Research my top competitors for handmade candles.' });
        assert.strictEqual(outcome.status, 'success');
        assert.strictEqual(outcome.error, null);
        assert.strictEqual(outcome.result.research_type, 'competitor_research');
        assert.strictEqual(outcome.result.specialized_records.length, 1);
        assert.strictEqual(outcome.result.specialized_records[0].competitor, 'Acme Candles');
        assert.deepStrictEqual(outcome.result.specialized_records[0].source, [
          'https://real-search-result.example/acme-candles',
        ]);
        // Grounded in a real, returned search result - honestly gradeable as verified,
        // not an invented upgrade (agent/core/researchAgent.js's composeResult would
        // itself downgrade this to unverified if no real evidence/source existed).
        assert.strictEqual(outcome.result.verification_status, 'verified');
        assert.ok(outcome.result.recommendations.includes('Consider a subscription offering, which Acme Candles lacks.'));
        // Real usage is surfaced (agent/core/usageLimits.js's MODEL_CALL_TOOL_IDS /
        // agent/core/tokenControls.js's shared per-run budget), not silently dropped.
        assert.strictEqual(outcome.model, 'claude-sonnet-5');
        assert.strictEqual(outcome.tokensUsed, 300);
        assert.strictEqual(outcome.inputTokens, 100);
        assert.strictEqual(outcome.outputTokens, 200);

        // The web_search tool was actually requested, and the objective (not some
        // structured research_params shape) was sent as the user message.
        assert.strictEqual(receivedRequest.tools[0].name, 'web_search');
        assert.strictEqual(receivedRequest.messages[0].content, 'Research my top competitors for handmade candles.');
      });
    } finally {
      claudeClient.sendMessage = originalSendMessage;
    }
  });

  await testAsync('MOCKED: reports status "partial" when only some claimed competitors verify, and drops the rest', async () => {
    const originalSendMessage = claudeClient.sendMessage;
    claudeClient.sendMessage = async () =>
      mockedSearchResponse({
        foundUrls: ['https://real.example/a'],
        replyJson: {
          competitors: [
            { competitor: 'Real Co.', strengths: ['x'], source: ['https://real.example/a'] },
            { competitor: 'Invented Co.', strengths: ['y'], source: ['https://never-returned.example/b'] },
          ],
        },
      });
    try {
      await withApiKeyConfigured(async () => {
        const outcome = await runWebCompetitorResearchTool({ objective: 'Find my top competitors.' });
        assert.strictEqual(outcome.status, 'partial');
        assert.strictEqual(outcome.result.specialized_records.length, 1);
        assert.strictEqual(outcome.result.specialized_records[0].competitor, 'Real Co.');
      });
    } finally {
      claudeClient.sendMessage = originalSendMessage;
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();
