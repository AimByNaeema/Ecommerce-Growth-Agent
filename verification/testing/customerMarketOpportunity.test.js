'use strict';

// Customer-related global market opportunity research: the scope engine, the candidate
// engine, the result contract, and the staged workflow end to end.
//
// NO LIVE RESEARCH HAPPENS HERE. Every web_search call is intercepted at
// agent/core/aiProviderSelector.js's sendMessage boundary and answered from a fixture, so this
// suite spends no Claude tokens, makes no network request, and its result does not depend
// on what the public web says today. The fixtures deliberately include the failure modes
// that matter: an unverifiable source URL, a fabricated number, a protected mark, and a
// seasonal product described as growing.

const assert = require('node:assert');
const aiProviderSelector = require('../../agent/core/aiProviderSelector');
const scopeEngine = require('../../agent/core/customerMarketScopeEngine');
const candidateEngine = require('../../agent/core/opportunityCandidateEngine');
const resultModel = require('../../agent/core/customerOpportunityResearchModel');
const workflow = require('../../workflows/customerMarketOpportunityWorkflow');
const { getToolById, TOOL_REGISTRY } = require('../../tools/toolRegistry');
const { checkToolAccess, TOOL_CLASSIFICATIONS } = require('../../agent/core/toolPermissions');
const { MODEL_CALL_TOOL_IDS, EXTERNAL_API_TOOL_IDS, RESEARCH_TOOL_IDS } = require('../../agent/core/usageLimits');
const { getSpecialistCapabilityById } = require('../../agent/core/specialistCapabilityRegistry');

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

// Replaces the PROVIDER SELECTOR's sendMessage for the duration of `fn`, restoring
// unconditionally - the same module-boundary convention every other suite in this project
// uses. The selector is the boundary the workflow actually calls (it supports Claude's
// hosted web_search and Gemini's Google Search grounding), so mocking it is what keeps
// these fixtures exercising the real code path.
//
// AI_PROVIDER is pinned to 'claude' for the duration because the fixtures below are
// Anthropic-shaped (raw.content web_search_tool_result blocks). That makes the real
// extractWebSearchResultUrls read them correctly, so URL VERIFICATION IS STILL REALLY
// EXERCISED here rather than stubbed out. Gemini's own grounding shape is covered by
// verification/testing/geminiWebGrounding.test.js.
function withMockedSendMessage(impl, fn) {
  const saved = aiProviderSelector.sendMessage;
  const savedConfigured = aiProviderSelector.isConfigured;
  const savedProvider = process.env.AI_PROVIDER;
  const savedSearchProvider = process.env.SEARCH_PROVIDER;
  aiProviderSelector.sendMessage = impl;
  aiProviderSelector.isConfigured = () => true;
  process.env.AI_PROVIDER = 'claude';
  // SEARCH_PROVIDER is pinned for the same reason AI_PROVIDER is: these fixtures are
  // Anthropic-shaped, so the run must take the model-native path that reads them. Without
  // this the suite inherits whatever the operator's .env happens to say - a machine with
  // SEARCH_PROVIDER=tavily would push these fixtures down the external-retrieval path and
  // fail for a reason that has nothing to do with the code under test. Gemini/Tavily paths
  // are covered by geminiWebGrounding.test.js and tavilySearchProvider.test.js.
  process.env.SEARCH_PROVIDER = 'claude_web_search';
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      aiProviderSelector.sendMessage = saved;
      aiProviderSelector.isConfigured = savedConfigured;
      if (savedProvider === undefined) delete process.env.AI_PROVIDER;
      else process.env.AI_PROVIDER = savedProvider;
      if (savedSearchProvider === undefined) delete process.env.SEARCH_PROVIDER;
      else process.env.SEARCH_PROVIDER = savedSearchProvider;
    });
}

// Builds a response shaped exactly like a real Anthropic reply carrying web_search
// results: `searchUrls` are the URLs search ITSELF returned (what verification checks
// against), `payload` is what the model claimed in its text block.
function searchResponse(searchUrls, payload) {
  return {
    model: 'claude-test',
    stopReason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 50 },
    raw: {
      content: [
        {
          type: 'web_search_tool_result',
          content: searchUrls.map((url) => ({ type: 'web_search_result', url, title: 'fixture' })),
        },
        { type: 'text', text: JSON.stringify(payload) },
      ],
    },
  };
}

const BUSINESS_CONFIG = {
  business_name: 'Digital Studio Fixture',
  business_model: 'B2C digital products business.',
  product_categories: ['SVG design files', 'PNG clipart'],
  target_markets: ['Global market for digital design assets'],
};

const CATALOGUE = [
  { channel: 'shopify', title: 'Halloween Ghost SVG Bundle', category: 'SVG design files', tags: ['halloween', 'svg'] },
  { channel: 'shopify', title: 'Halloween Pumpkin SVG Cut File', category: 'SVG design files', tags: ['halloween', 'svg'] },
  { channel: 'shopify', title: 'Christmas Tree SVG Bundle', category: 'SVG design files', tags: ['christmas', 'svg'] },
  { channel: 'etsy', title: 'Christmas PNG Clipart Set', category: 'PNG clipart', tags: ['christmas', 'clipart'] },
];

const REAL_URL_A = 'https://example.test/craft-market-report';
const REAL_URL_B = 'https://example.test/seasonal-svg-trends';

async function main() {
  // --- 1. Customer context extraction ------------------------------------------------

  test('CUSTOMER CONTEXT: built from the real catalogue and config, per channel', () => {
    const ctx = scopeEngine.extractCustomerContext({ businessConfig: BUSINESS_CONFIG, catalogue: CATALOGUE });
    assert.strictEqual(ctx.business_name, 'Digital Studio Fixture');
    assert.strictEqual(ctx.product_count, 4);
    // Channels are counted separately and never merged into one number.
    assert.deepStrictEqual(ctx.products_by_channel, { shopify: 3, etsy: 1 });
    assert.deepStrictEqual(ctx.channels.sort(), ['etsy', 'shopify']);
    assert.deepStrictEqual(ctx.declared_categories, ['SVG design files', 'PNG clipart']);
  });

  // --- 2. Related-market generation ---------------------------------------------------

  test('MARKET SCOPE: primary market is the customer\'s own dominant category, with its basis', () => {
    const out = scopeEngine.buildCustomerMarketScope({ businessConfig: BUSINESS_CONFIG, catalogue: CATALOGUE });
    assert.strictEqual(out.status, 'complete');
    assert.strictEqual(out.market_scope.primary_market, 'svg design files');
    assert.ok(out.market_scope.related_markets.includes('png clipart'));
    // Every derived value states HOW it was derived.
    assert.ok(/occurrence/.test(out.market_scope.primary_market_basis));
    // Recurring catalogue terms become buyer intents; a term used once does not.
    assert.ok(out.market_scope.buyer_intents.includes('halloween'));
    assert.ok(out.market_scope.buyer_intents.includes('christmas'));
  });

  test('MARKET SCOPE: no adjacent market is invented locally, and geography is never assumed global', () => {
    const out = scopeEngine.buildCustomerMarketScope({
      businessConfig: { ...BUSINESS_CONFIG, target_markets: [], countries: [] },
      catalogue: CATALOGUE,
    });
    // related_markets contains ONLY categories the business already sells in.
    for (const market of out.market_scope.related_markets) {
      assert.ok(
        BUSINESS_CONFIG.product_categories.some((c) => c.toLowerCase() === market),
        `"${market}" is not one of this business's own categories - an adjacency was invented locally`
      );
    }
    assert.deepStrictEqual(out.market_scope.geographies, []);
    assert.ok(/not assumed to be global/i.test(out.market_scope.geographies_basis));
  });

  // --- 3. Missing-data handling -------------------------------------------------------

  test('NEEDS_INFORMATION: too little business context stops the pipeline instead of guessing a niche', () => {
    const out = scopeEngine.buildCustomerMarketScope({ businessConfig: {}, catalogue: [] });
    assert.strictEqual(out.status, 'needs_information');
    assert.strictEqual(out.market_scope, null);
    assert.ok(out.missing_information.length >= 1);
  });

  await testAsync('NEEDS_INFORMATION: with no niche, NO research call is made at all', async () => {
    let called = 0;
    await withMockedSendMessage(
      async () => {
        called += 1;
        return searchResponse([REAL_URL_A], { candidates: [] });
      },
      async () => {
        const result = await workflow.runCustomerMarketOpportunityResearch({ businessConfig: {}, catalogue: [] });
        assert.strictEqual(result.status, 'needs_information');
        assert.strictEqual(called, 0, 'no token may be spent researching a market that was never established');
        assert.strictEqual(result.top_opportunities.length, 0);
      }
    );
  });

  // --- 4. De-duplication --------------------------------------------------------------

  test('DEDUPLICATION: variants collapse to one candidate and their evidence is UNIONED', () => {
    const deduped = candidateEngine.dedupeCandidates([
      { product: 'Bridal Shower Invitations', evidence: [{ source_url: 'u1' }] },
      { product: 'bridal shower invitation', evidence: [{ source_url: 'u2' }] },
      { product: 'Invitation Bridal Shower', evidence: [{ source_url: 'u1' }] },
      { product: 'Wedding Signage', evidence: [{ source_url: 'u3' }] },
    ]);
    assert.strictEqual(deduped.length, 2);
    const merged = deduped.find((c) => c.variant_names.length > 1);
    assert.strictEqual(merged.variant_names.length, 3);
    assert.strictEqual(merged.mention_count, 3);
    // Two distinct sources survive; the repeated one is not double-counted as two
    // independent confirmations.
    assert.strictEqual(merged.evidence.length, 2);
  });

  // --- 5. Customer-fit scoring --------------------------------------------------------

  test('CUSTOMER FIT: scored from real term overlap, and it NAMES the matched terms', () => {
    const scope = { primary_market: 'svg design files', related_markets: ['png clipart'], buyer_intents: ['halloween'] };
    const relevant = candidateEngine.scoreCustomerFit({ product: 'Halloween SVG Design Files Bundle' }, scope);
    const irrelevant = candidateEngine.scoreCustomerFit({ product: 'Stainless Steel Kitchen Blender' }, scope);

    assert.ok(relevant.score > irrelevant.score);
    assert.strictEqual(irrelevant.score, 0);
    assert.ok(relevant.matched_terms.primary_market.includes('svg design files'));
    assert.ok(relevant.matched_terms.buyer_intent.includes('halloween'));
    // The "why THIS customer" answer is built from words both sides genuinely contain.
    assert.ok(relevant.reason.includes('svg design files'));
    assert.ok(/No term in this candidate matches/.test(irrelevant.reason));
  });

  // --- 6. Compliance filtering --------------------------------------------------------

  test('COMPLIANCE: BLOCK is excluded from ranking, REVIEW survives but is not cleared', () => {
    const { eligible, excluded } = candidateEngine.filterByCompliance([
      { product: 'A', compliance: { status: 'PASS' } },
      { product: 'B', compliance: { status: 'REVIEW' } },
      { product: 'C', compliance: { status: 'BLOCK', findings: [] } },
      { product: 'D', compliance: {} },
    ]);
    assert.deepStrictEqual(eligible.map((c) => c.product), ['A', 'B']);
    assert.deepStrictEqual(excluded.map((c) => c.product).sort(), ['C', 'D']);
    // A REVIEW candidate keeps its verdict all the way through - never silently upgraded.
    assert.strictEqual(eligible.find((c) => c.product === 'B').compliance.status, 'REVIEW');
  });

  test('COMPLIANCE: a protected mark BLOCKS and is never reworded around', () => {
    const verdict = workflow.assessCandidateCompliance({ product: 'Disney Princess Party Invitation', evidence: [] });
    assert.strictEqual(verdict.status, 'BLOCK');
    assert.ok(verdict.findings.some((f) => f.check_type === 'ip_indicators'));
    assert.ok(/Excluded rather than reworded/i.test(verdict.findings[0].message));
    // A clean candidate in the same market is not blocked.
    assert.notStrictEqual(workflow.assessCandidateCompliance({ product: 'Bridal Shower Invitation Template', evidence: [] }).status, 'BLOCK');
  });

  // --- 7. Ranking ---------------------------------------------------------------------

  test('RANKING: equal-weight mean of evidence coverage and customer fit, contiguous ranks', () => {
    assert.strictEqual(candidateEngine.rankScore(100, 0), 50);
    assert.strictEqual(candidateEngine.rankScore(50, 50), 50);
    const { ranked } = candidateEngine.rankCandidates([
      { product: 'Low', evidence: [{ source_url: 'u' }], coverage_score: { percentage: 25 }, customer_fit: { score: 25 } },
      { product: 'High', evidence: [{ source_url: 'u' }], coverage_score: { percentage: 100 }, customer_fit: { score: 100 } },
      { product: 'Mid', evidence: [{ source_url: 'u' }], coverage_score: { percentage: 50 }, customer_fit: { score: 50 } },
    ]);
    assert.deepStrictEqual(ranked.map((r) => r.product), ['High', 'Mid', 'Low']);
    assert.deepStrictEqual(ranked.map((r) => r.rank), [1, 2, 3]);
  });

  test('FEWER THAN 10: unevidenced candidates are dropped, never used to pad the list', () => {
    const { ranked, dropped } = candidateEngine.rankCandidates(
      [
        { product: 'Evidenced', evidence: [{ source_url: 'u' }], coverage_score: { percentage: 50 }, customer_fit: { score: 50 } },
        { product: 'Unevidenced', evidence: [], coverage_score: { percentage: 90 }, customer_fit: { score: 90 } },
      ],
      { limit: 10 }
    );
    assert.strictEqual(ranked.length, 1, 'the list must be short rather than padded');
    assert.strictEqual(dropped.length, 1);
    assert.ok(/left empty rather than filled/i.test(dropped[0].reason));
  });

  // --- 8. No fabricated metrics -------------------------------------------------------

  test('NO FAKE DATA: a number without a measured/estimated grade is discarded, not kept', () => {
    // The model claimed a specific figure but graded it an inference - the figure is
    // dropped and the characterisation is preserved.
    const inferred = workflow.normalizeSignal({ value: 72000, unit: 'searches/month', grade: 'inferred', assessment: 'Seems popular.' }, ['u'], 'demand');
    assert.strictEqual(inferred.value, null, 'an inferred figure must never be reported as a value');
    assert.strictEqual(inferred.assessment, 'Seems popular.');

    // A genuinely measured figure survives with its unit.
    const measured = workflow.normalizeSignal({ value: 1200, unit: 'listings', grade: 'measured', assessment: 'Marketplace reported 1200 listings.' }, ['u'], 'competition');
    assert.strictEqual(measured.value, 1200);
    assert.strictEqual(measured.unit, 'listings');
    assert.strictEqual(measured.grade, 'measured');

    // Nothing at all becomes an explicit unavailable, never 0.
    const missing = workflow.normalizeSignal(null, [], 'demand');
    assert.strictEqual(missing.value, null);
    assert.notStrictEqual(missing.value, 0);
    assert.strictEqual(missing.grade, 'unknown');
    assert.ok(/Not available from current research sources/.test(missing.assessment));
  });

  test('RESULT CONTRACT: rejects a ranked BLOCK, a bad trend, and an "unknown" carrying a value', () => {
    const base = resultModel.createEmptyCustomerOpportunityResearch();
    const opportunity = {
      rank: 1,
      product: 'X',
      evidence: [{ source_url: 'u' }],
      trend: { classification: 'growing' },
      compliance: { status: 'PASS' },
    };
    assert.strictEqual(resultModel.validateCustomerOpportunityResearchShape({ ...base, status: 'complete', top_opportunities: [opportunity] }).valid, true);

    const blocked = resultModel.validateCustomerOpportunityResearchShape({
      ...base,
      status: 'complete',
      top_opportunities: [{ ...opportunity, compliance: { status: 'BLOCK' } }],
    });
    assert.strictEqual(blocked.valid, false);
    assert.ok(blocked.errors.some((e) => /BLOCK/.test(e)));

    const badTrend = resultModel.validateCustomerOpportunityResearchShape({
      ...base,
      status: 'complete',
      top_opportunities: [{ ...opportunity, trend: { classification: 'skyrocketing' } }],
    });
    assert.strictEqual(badTrend.valid, false);

    const unknownWithValue = resultModel.validateCustomerOpportunityResearchShape({
      ...base,
      status: 'complete',
      top_opportunities: [{ ...opportunity, demand: { grade: 'unknown', value: 500 } }],
    });
    assert.strictEqual(unknownWithValue.valid, false);
    assert.ok(unknownWithValue.errors.some((e) => /unknown.*must be null/i.test(e)));

    const unevidenced = resultModel.validateCustomerOpportunityResearchShape({
      ...base,
      status: 'complete',
      top_opportunities: [{ ...opportunity, evidence: [] }],
    });
    assert.strictEqual(unevidenced.valid, false);
  });

  test('TREND: seasonal is a first-class classification, distinct from growing', () => {
    assert.ok(resultModel.TREND_CLASSIFICATIONS.includes('seasonal'));
    assert.ok(resultModel.TREND_CLASSIFICATIONS.includes('unknown'));
    // The validation prompt instructs the distinction explicitly, so a yearly spike is
    // never promoted to growth.
    assert.ok(/seasonal.*NOT.*growing/i.test(workflow.VALIDATION_SYSTEM_PROMPT));
  });

  // --- 9. End-to-end, with every web_search call mocked --------------------------------

  await testAsync('END TO END: catalogue -> scope -> discovery -> validation -> compliance -> Top N', async () => {
    let call = 0;
    await withMockedSendMessage(
      async () => {
        call += 1;
        if (call <= 2) {
          return searchResponse([REAL_URL_A, REAL_URL_B], {
            candidates: [
              { product: 'Halloween SVG Bundle', market: 'svg design files', keywords: ['halloween', 'svg'], why_related: 'Same market.', source: [REAL_URL_A] },
              { product: 'Halloween SVG Bundles', market: 'svg design files', keywords: ['halloween'], why_related: 'Duplicate wording.', source: [REAL_URL_B] },
              { product: 'Christmas PNG Clipart Pack', market: 'png clipart', keywords: ['christmas'], why_related: 'Adjacent category.', source: [REAL_URL_A] },
              { product: 'Disney Princess SVG', market: 'svg design files', keywords: ['disney'], why_related: 'High demand.', source: [REAL_URL_A] },
              // Unverifiable: this URL is NOT in the search results above.
              { product: 'Fabricated Opportunity', market: 'svg design files', keywords: ['svg'], why_related: 'Invented.', source: ['https://never-returned.test/x'] },
              { product: 'Stainless Kitchen Blender', market: 'appliances', keywords: ['blender'], why_related: 'Unrelated.', source: [REAL_URL_A] },
            ],
          });
        }
        return searchResponse([REAL_URL_A, REAL_URL_B], {
          validated: [
            {
              product: 'Halloween SVG Bundle',
              demand: { assessment: 'Craft marketplaces report steady interest.', value: null, grade: 'inferred' },
              competition: { assessment: 'Many sellers listed.', value: 1200, unit: 'listings', grade: 'measured' },
              trend: { classification: 'seasonal', assessment: 'Peaks each October.', grade: 'inferred' },
              commercial: { assessment: 'Typically low single-digit prices.', value: null, grade: 'inferred' },
              source: [REAL_URL_A],
            },
            {
              product: 'Christmas PNG Clipart Pack',
              demand: { assessment: 'Reported as a common craft purchase.', value: null, grade: 'inferred' },
              competition: { assessment: 'Crowded.', value: null, grade: 'inferred' },
              trend: { classification: 'seasonal', assessment: 'Peaks each December.', grade: 'inferred' },
              commercial: { assessment: 'Low price point.', value: null, grade: 'inferred' },
              source: [REAL_URL_B],
            },
          ],
        });
      },
      async () => {
        const result = await workflow.runCustomerMarketOpportunityResearch({
          businessConfig: BUSINESS_CONFIG,
          catalogue: CATALOGUE,
          limit: 10,
        });

        // The contract holds.
        const shape = resultModel.validateCustomerOpportunityResearchShape(result);
        assert.strictEqual(shape.valid, true, `contract violations: ${shape.errors.join('; ')}`);
        assert.strictEqual(result.status, 'complete');

        // The funnel is real: discovered > deduplicated > ranked.
        assert.ok(result.candidate_count.discovered > result.candidate_count.after_deduplication);
        assert.ok(result.candidate_count.ranked >= 1);

        const names = result.top_opportunities.map((o) => o.product);
        // The unverifiable candidate never entered the pool at all.
        assert.ok(!names.includes('Fabricated Opportunity'), 'a candidate whose URL search never returned must be dropped');
        // The protected mark is excluded, however "high demand" it claimed to be.
        assert.ok(!names.includes('Disney Princess SVG'), 'a protected mark must never be ranked');
        // The unrelated product cannot outrank a relevant one.
        assert.ok(!names.includes('Stainless Kitchen Blender'), 'an unrelated product must not reach the Top N');
        // The duplicate collapsed.
        assert.strictEqual(names.filter((n) => /halloween svg bundle/i.test(n)).length, 1);

        const top = result.top_opportunities[0];
        assert.strictEqual(top.rank, 1);
        assert.ok(top.customer_fit_reason.length > 0);
        assert.ok(top.evidence.length > 0);
        assert.ok(top.evidence.every((e) => [REAL_URL_A, REAL_URL_B].includes(e.source_url)));
        // Ranking is labelled for what it is.
        assert.ok(/NOT a prediction of sales or profit/i.test(top.scores.rank_basis));
        // Seasonality survived as seasonality.
        const halloween = result.top_opportunities.find((o) => /halloween/i.test(o.product));
        assert.strictEqual(halloween.trend.classification, 'seasonal');
        // The measured competition figure survived with its unit.
        assert.strictEqual(halloween.competition.value, 1200);
        assert.strictEqual(halloween.competition.unit, 'listings');
        // The inferred demand figure did not become a number.
        assert.strictEqual(halloween.demand.value, null);

        // Provenance and cost are reported.
        assert.ok(result.research_summary.verified_source_count >= 1);
        assert.ok(result.research_summary.model_calls >= 2);
        assert.ok(result.research_summary.usage.tokensUsed > 0);
        // The unavailable-metrics limitation is always stated.
        assert.ok(result.limitations.some((l) => /No search-volume provider/i.test(l)));
      }
    );
  });

  await testAsync('END TO END: unverifiable research yields no opportunities rather than invented ones', async () => {
    await withMockedSendMessage(
      async () =>
        searchResponse([REAL_URL_A], {
          candidates: [{ product: 'Ghost Opportunity', market: 'svg design files', source: ['https://never-returned.test/y'] }],
        }),
      async () => {
        const result = await workflow.runCustomerMarketOpportunityResearch({ businessConfig: BUSINESS_CONFIG, catalogue: CATALOGUE });
        assert.strictEqual(result.top_opportunities.length, 0);
        assert.strictEqual(result.status, 'partial');
        assert.ok(result.limitations.some((l) => /no candidate with a verifiable source/i.test(l)));
      }
    );
  });

  // --- 10. Cost control ----------------------------------------------------------------

  await testAsync('TOKEN COST: deep research is spent only on the shortlist, not on every candidate', async () => {
    let discoveryCalls = 0;
    let validationCalls = 0;
    await withMockedSendMessage(
      async ({ system }) => {
        const isDiscovery = system === workflow.DISCOVERY_SYSTEM_PROMPT;
        if (isDiscovery) discoveryCalls += 1;
        else validationCalls += 1;
        if (isDiscovery) {
          return searchResponse([REAL_URL_A], {
            candidates: Array.from({ length: 40 }, (_, i) => ({
              product: i < 20 ? `Halloween SVG Variant ${i}` : `Unrelated Widget ${i}`,
              market: i < 20 ? 'svg design files' : 'hardware',
              source: [REAL_URL_A],
            })),
          });
        }
        return searchResponse([REAL_URL_A], { validated: [] });
      },
      async () => {
        const result = await workflow.runCustomerMarketOpportunityResearch({
          businessConfig: BUSINESS_CONFIG,
          catalogue: CATALOGUE,
          discoveryBatches: 2,
        });
        // 40 candidates discovered per batch, but validation is ONE batched call - never
        // one call per candidate.
        assert.strictEqual(discoveryCalls, 2);
        assert.strictEqual(validationCalls, 1, 'deep research must be a single batched call, not per-candidate');
        assert.ok(result.candidate_count.discovered >= 40);
        // Total model calls stay well inside the project's 10-per-run ceiling.
        assert.ok(result.research_summary.model_calls <= 4, `model_calls was ${result.research_summary.model_calls}`);
      }
    );
  });

  // --- 11. Registration, permissions, isolation ----------------------------------------

  test('REGISTERED: a read tool, classified analysis_only, owned by the Product specialist', () => {
    // Owned by PRODUCT, not Research: its deliverable is validated, customer-fit-scored,
    // ranked product opportunities, which is the Product Agent's declared remit - and it is
    // the specialist the Chief's own free-text routing sends "what should this store sell
    // next" to, so this is also what makes the capability reachable without the user
    // picking a specialist by hand.
    const tool = getToolById('catalogue_expansion_opportunities');
    assert.strictEqual(tool.operation, 'read');
    assert.strictEqual(tool.category, 'products');
    assert.strictEqual(tool.status, 'implemented');
    assert.strictEqual(TOOL_CLASSIFICATIONS.catalogue_expansion_opportunities, 'analysis_only');
    assert.strictEqual(checkToolAccess({ specialistId: 'product', toolId: 'catalogue_expansion_opportunities' }).decision, 'allowed');
    for (const specialistId of ['listing', 'marketing', 'seo', 'social_advertising', 'analytics_optimization']) {
      assert.strictEqual(
        checkToolAccess({ specialistId, toolId: 'catalogue_expansion_opportunities' }).decision,
        'denied',
        `${specialistId} must be denied`
      );
    }
    const capability = getSpecialistCapabilityById('product').supported_tasks.find((t) => t.id === 'catalogue_expansion_opportunities');
    assert.ok(capability, 'the Product specialist must own this capability');
  });

  test('BUDGETED: counted as a model call, an external API call, and a research call', () => {
    for (const [name, set] of [['model', MODEL_CALL_TOOL_IDS], ['external API', EXTERNAL_API_TOOL_IDS], ['research', RESEARCH_TOOL_IDS]]) {
      assert.ok(set.has('catalogue_expansion_opportunities'), `must count against the per-run ${name} budget`);
    }
  });

  test('NO PUBLISHING PATH: research ends at opportunities', () => {
    // Structural: no write/execute Etsy or Shopify tool is reachable from this capability,
    // and the tool itself is a read.
    const capability = getSpecialistCapabilityById('product').supported_tasks.find((t) => t.id === 'catalogue_expansion_opportunities');
    for (const toolId of capability.tool_ids) {
      assert.strictEqual(getToolById(toolId).operation, 'read', `${toolId} must be a read operation`);
    }
    const fs = require('node:fs');
    const path = require('node:path');
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'workflows', 'customerMarketOpportunityWorkflow.js'), 'utf8');
    for (const forbidden of ['publishListing', 'productCreate', 'createDraftListing', 'inventoryAdjust']) {
      assert.ok(!source.includes(forbidden), `the workflow must not reference ${forbidden}`);
    }
  });

  test('CHANNEL ISOLATION: catalogue records keep their own channel and are never merged', () => {
    const ctx = scopeEngine.extractCustomerContext({ businessConfig: BUSINESS_CONFIG, catalogue: CATALOGUE });
    const channels = ctx.catalogue_entries.map((e) => e.channel);
    assert.deepStrictEqual([...new Set(channels)].sort(), ['etsy', 'shopify']);
    // Each entry keeps exactly the channel it arrived with - no record acquires a second.
    for (const entry of ctx.catalogue_entries) {
      assert.ok(entry.channel === 'shopify' || entry.channel === 'etsy');
    }
    assert.strictEqual(ctx.products_by_channel.shopify + ctx.products_by_channel.etsy, ctx.product_count);
  });

  test('BACKWARD COMPATIBLE: the existing Product Agent and scoring engine are untouched', () => {
    const productAgent = require('../../agent/core/productAgent');
    assert.deepStrictEqual(Object.keys(productAgent).sort(), ['analyzeProductOpportunity', 'buildDimension', 'discoverProducts', 'validateProduct']);
    const scoring = require('../../agent/core/productOpportunityScoringEngine');
    assert.deepStrictEqual(Object.keys(scoring), ['scoreProductOpportunity']);
    // The existing 8-dimension coverage model still reports coverage, not a quality score.
    const scoreModel = require('../../agent/core/productOpportunityScoreModel');
    assert.strictEqual(scoreModel.PRODUCT_OPPORTUNITY_SCORE_DIMENSIONS.length, 8);
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('customerMarketOpportunity.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main();
