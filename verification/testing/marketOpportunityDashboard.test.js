'use strict';

// The market-opportunity dashboard surface: GET /overview's `market_research` block.
//
// PRESENTATION OVER SAVED DATA. This surface runs no research. It reads the newest saved
// run record from agent/core/runHistoryStore.js and relays what
// workflows/customerMarketOpportunityWorkflow.js already produced. These tests pin exactly
// that: the relay is verbatim, an absent metric stays absent, and opening the dashboard
// starts nothing.
//
// Follows verification/testing/dashboardOverviewEndpoint.test.js's harness: real HTTP
// against a locally started createApp(), a throwaway RUN_HISTORY_STORE_DIR, and
// monkey-patched module functions so nothing reaches a network.

const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.RUN_HISTORY_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'market-opp-test-'));
const TEST_API_KEY = 'test-agent-api-key-do-not-use-in-production';
process.env.AGENT_API_KEY = TEST_API_KEY;
process.env.RATE_LIMIT_MAX_REQUESTS = '10000';

const { createApp } = require('../../server');
const runHistoryStore = require('../../agent/core/runHistoryStore');
const etsyReadClient = require('../../integrations/adapters/etsyReadClient');
const etsyClient = require('../../integrations/adapters/etsyClient');
const etsyOAuth = require('../../integrations/etsyOAuth');
const customerMarketOpportunityTool = require('../../tools/customerMarketOpportunityTool');
const { TOOL_REGISTRY } = require('../../tools/toolRegistry');

// This suite must never touch a live API. GET /store/metrics is not exercised here, but
// GET /overview calls canRead() as a local credential check - pinned false so the suite
// behaves identically on a machine with Etsy configured.
etsyReadClient.canRead = () => false;

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

function authedGet(port, reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: reqPath, method: 'GET', headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, raw }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function withServer(fn) {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function clearStore() {
  const dir = process.env.RUN_HISTORY_STORE_DIR;
  for (const file of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, file));
}

// One opportunity shaped EXACTLY like the real pipeline's output (verified against a real
// saved record: rank, product, customer_fit_reason, market, demand, competition, trend,
// commercial, scores, compliance, confidence, evidence, variant_names, mention_count).
function opportunity(rank, product, overrides = {}) {
  return Object.assign(
    {
      rank,
      product,
      customer_fit_reason: `Relevant because it overlaps ${product}.`,
      market: 'font bundles',
      demand: { metric: 'demand', value: null, unit: null, grade: 'inferred', assessment: 'Steady interest.', source: ['https://example.test/a'], source_url: 'https://example.test/a', retrieved_at: '2026-09-10T00:00:00.000Z', confidence: 'low' },
      competition: { metric: 'competition', value: 4300, unit: 'listings', grade: 'measured', assessment: 'Crowded.', source: ['https://example.test/a'], source_url: 'https://example.test/a', retrieved_at: '2026-09-10T00:00:00.000Z', confidence: 'medium' },
      trend: { metric: 'trend', classification: 'seasonal', assessment: 'Peaks in December.', grade: 'inferred', value: null, source: ['https://example.test/a'], confidence: 'medium' },
      commercial: { metric: 'commercial', value: null, unit: null, grade: 'inferred', assessment: 'Low price point.', source: [], source_url: null, retrieved_at: null, confidence: 'low' },
      scores: {
        customer_fit: 100,
        evidence_coverage: 100,
        rank_score: 100,
        rank_basis: 'Equal-weight mean of evidence coverage and customer fit, both mechanical measurements. This orders by "best-evidenced and most relevant to this business" - it is NOT a prediction of sales or profit.',
        matched_terms: { primary_market: ['digital design bundle'], related_market: ['font bundles'], buyer_intent: ['bundle'] },
      },
      compliance: { status: 'PASS', review_reasons: [], findings: [], limitations: [], checked_at: null, checker_version: '1' },
      confidence: 'medium',
      evidence: [{ metric: 'discovery', assessment: 'Existing category.', value: null, unit: null, grade: 'inferred', source_url: 'https://example.test/a', retrieved_at: '2026-09-10T00:00:00.000Z' }],
      variant_names: [product],
      mention_count: 1,
    },
    overrides
  );
}

// A saved run record with a research result at the real path:
// result.routing.plan[i].outputs.result.top_opportunities
function seedResearchRun(products, resultOverrides = {}, recordOverrides = {}) {
  const runId = recordOverrides.run_id || `cc-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const record = Object.assign(
    {
      run_id: runId,
      kind: 'orchestrate',
      objective: 'Find products related to my existing products that we could sell next.',
      status: 'success',
      summary: 'Product completed this request successfully.',
      session_id: 'cc-session-1',
      channel: null,
      created_at: new Date().toISOString(),
      result: {
        routing: {
          status: 'complete',
          plan: [
            {
              selected_specialist: { type: 'specialist', id: 'product', title: 'Product' },
              tool_calls: ['catalogue_expansion_opportunities'],
              completion_state: 'complete',
              outputs: {
                result: Object.assign(
                  {
                    status: 'complete',
                    customer_context: { business_name: 'Fixture Studio', product_count: 75 },
                    market_scope: { primary_market: 'digital design bundle', related_markets: ['font bundles'], buyer_intents: ['bundle'], geographies: [], channels: ['shopify', 'etsy'] },
                    candidate_count: { discovered: 10, after_deduplication: 5, compliance_eligible: 3, ranked: products.length },
                    top_opportunities: products.map((p, i) => opportunity(i + 1, p)),
                    excluded_opportunities: [{ product: 'Disney Castle SVG', compliance_status: 'BLOCK', reason: 'Protected mark.', findings: [] }],
                    research_summary: { stages: [], sources_used: ['https://example.test/a'], verified_source_count: 1, model_calls: 3, generated_at: '2026-09-10T00:00:00.000Z' },
                    limitations: ['No search-volume provider is connected.'],
                  },
                  resultOverrides
                ),
              },
            },
          ],
        },
      },
    },
    recordOverrides
  );
  runHistoryStore.saveRunRecord(record);
  return record;
}

async function main() {
  // --- Empty state ---------------------------------------------------------------------

  await testAsync('EMPTY STATE: no research yet is reported honestly, never as zero opportunities', async () => {
    clearStore();
    await withServer(async (port) => {
      const data = JSON.parse((await authedGet(port, '/overview')).raw);
      assert.strictEqual(data.market_research.available, false);
      assert.strictEqual(data.market_research.reason, 'No market research run yet.');
      assert.strictEqual(data.market_research.opportunities, undefined, 'an empty result must not fabricate an opportunity list');
    });
  });

  // --- The relay -------------------------------------------------------------------------

  await testAsync('RELAY: the newest saved research is exposed verbatim on GET /overview', async () => {
    clearStore();
    const record = seedResearchRun(['Monogram Font Bundle', 'Christmas SVG Bundle', 'Halloween PNG Designs']);
    await withServer(async (port) => {
      const mr = JSON.parse((await authedGet(port, '/overview')).raw).market_research;
      assert.strictEqual(mr.available, true);
      assert.strictEqual(mr.run_id, record.run_id);
      assert.strictEqual(mr.session_id, 'cc-session-1');
      assert.strictEqual(mr.research_status, 'complete');
      assert.strictEqual(mr.run_status, 'success');
      assert.deepStrictEqual(mr.candidate_count, { discovered: 10, after_deduplication: 5, compliance_eligible: 3, ranked: 3 });
      assert.strictEqual(mr.market_scope.primary_market, 'digital design bundle');
      assert.strictEqual(mr.research_summary.verified_source_count, 1);
      assert.strictEqual(mr.excluded_count, 1);
      // Opportunities are relayed unchanged - the dashboard re-scores nothing.
      assert.strictEqual(mr.opportunities.length, 3);
      assert.strictEqual(mr.opportunities[0].scores.rank_score, 100);
      assert.ok(/NOT a prediction of sales or profit/i.test(mr.opportunities[0].scores.rank_basis));
    });
  });

  await testAsync('NEWEST WINS: an older research run does not shadow a newer one', async () => {
    clearStore();
    seedResearchRun(['Old Result'], {}, { run_id: 'run-old', created_at: '2020-01-01T00:00:00.000Z' });
    seedResearchRun(['New Result'], {}, { run_id: 'run-new', created_at: '2030-01-01T00:00:00.000Z' });
    await withServer(async (port) => {
      const mr = JSON.parse((await authedGet(port, '/overview')).raw).market_research;
      assert.strictEqual(mr.run_id, 'run-new');
      assert.strictEqual(mr.opportunities[0].product, 'New Result');
    });
  });

  // --- Up to 10, never padded ------------------------------------------------------------

  await testAsync('UP TO 10: ten are relayed in full, and four stay four', async () => {
    clearStore();
    seedResearchRun(Array.from({ length: 10 }, (_, i) => `Opportunity ${i + 1}`));
    await withServer(async (port) => {
      const mr = JSON.parse((await authedGet(port, '/overview')).raw).market_research;
      assert.strictEqual(mr.opportunities.length, 10);
      assert.deepStrictEqual(mr.opportunities.map((o) => o.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    clearStore();
    seedResearchRun(['A', 'B', 'C', 'D']);
    await withServer(async (port) => {
      const mr = JSON.parse((await authedGet(port, '/overview')).raw).market_research;
      // FOUR, not four plus six placeholders.
      assert.strictEqual(mr.opportunities.length, 4);
      assert.ok(mr.opportunities.every((o) => o.product && o.product.trim() !== ''));
      const names = mr.opportunities.map((o) => o.product);
      assert.strictEqual(new Set(names).size, names.length, 'no duplicate opportunity may be relayed');
    });
  });

  await testAsync('NO QUALIFYING OPPORTUNITIES: an empty ranked list is relayed as empty, not hidden', async () => {
    clearStore();
    seedResearchRun([], { status: 'partial', candidate_count: { discovered: 12, after_deduplication: 6, compliance_eligible: 0, ranked: 0 } });
    await withServer(async (port) => {
      const mr = JSON.parse((await authedGet(port, '/overview')).raw).market_research;
      assert.strictEqual(mr.available, true, 'research DID run - that fact must not be lost');
      assert.strictEqual(mr.research_status, 'partial');
      assert.deepStrictEqual(mr.opportunities, []);
      // A measured zero survives as 0, distinct from a missing figure.
      assert.strictEqual(mr.candidate_count.ranked, 0);
      assert.strictEqual(mr.candidate_count.discovered, 12);
    });
  });

  // --- null is not zero --------------------------------------------------------------------

  await testAsync('NULL IS NOT ZERO: an unavailable metric stays null, and a measured figure keeps its unit', async () => {
    clearStore();
    seedResearchRun(['Alpha']);
    await withServer(async (port) => {
      const o = JSON.parse((await authedGet(port, '/overview')).raw).market_research.opportunities[0];
      assert.strictEqual(o.demand.value, null, 'an inferred demand must not become 0');
      assert.notStrictEqual(o.demand.value, 0);
      assert.strictEqual(o.demand.grade, 'inferred');
      assert.strictEqual(o.competition.value, 4300);
      assert.strictEqual(o.competition.unit, 'listings');
      assert.strictEqual(o.competition.grade, 'measured');
    });
  });

  await testAsync('MISSING candidate_count is null, NOT a zeroed object', async () => {
    clearStore();
    seedResearchRun(['Alpha'], { candidate_count: undefined });
    await withServer(async (port) => {
      const mr = JSON.parse((await authedGet(port, '/overview')).raw).market_research;
      assert.strictEqual(mr.candidate_count, null, 'an absent funnel must be null so the UI can say Unavailable');
    });
  });

  // --- Trend, customer fit, compliance -----------------------------------------------------

  await testAsync('TREND: the classification is relayed verbatim - seasonal never becomes growing', async () => {
    clearStore();
    seedResearchRun(['Alpha', 'Beta'], {
      top_opportunities: [
        opportunity(1, 'Alpha', { trend: { metric: 'trend', classification: 'seasonal', assessment: 'Peaks in October.', grade: 'inferred', value: null, source: [], confidence: 'medium' } }),
        opportunity(2, 'Beta', { trend: { metric: 'trend', classification: 'unknown', assessment: 'Not available from current research sources.', grade: 'unknown', value: null, source: [], confidence: 'low' } }),
      ],
    });
    await withServer(async (port) => {
      const list = JSON.parse((await authedGet(port, '/overview')).raw).market_research.opportunities;
      assert.strictEqual(list[0].trend.classification, 'seasonal');
      assert.strictEqual(list[1].trend.classification, 'unknown', 'unknown must never be relayed as stable');
    });
  });

  await testAsync('CUSTOMER FIT: the backend reason and matched terms are relayed, not recomputed', async () => {
    clearStore();
    seedResearchRun(['Alpha']);
    await withServer(async (port) => {
      const o = JSON.parse((await authedGet(port, '/overview')).raw).market_research.opportunities[0];
      assert.ok(o.customer_fit_reason.length > 0);
      assert.deepStrictEqual(o.scores.matched_terms.primary_market, ['digital design bundle']);
      assert.strictEqual(o.scores.customer_fit, 100);
    });
  });

  await testAsync('COMPLIANCE: PASS/REVIEW/BLOCK are relayed unchanged, and a BLOCK is not laundered', async () => {
    clearStore();
    seedResearchRun(['Alpha', 'Beta'], {
      top_opportunities: [
        opportunity(1, 'Alpha', { compliance: { status: 'REVIEW', review_reasons: ['ambiguous claim'], findings: [], limitations: [], checked_at: null, checker_version: '1' } }),
        opportunity(2, 'Beta'),
      ],
    });
    await withServer(async (port) => {
      const mr = JSON.parse((await authedGet(port, '/overview')).raw).market_research;
      assert.strictEqual(mr.opportunities[0].compliance.status, 'REVIEW');
      assert.deepStrictEqual(mr.opportunities[0].compliance.review_reasons, ['ambiguous claim']);
      assert.strictEqual(mr.opportunities[1].compliance.status, 'PASS');
      // A BLOCK never reaches the ranked list at all - the pipeline excluded it, and the
      // relay must not resurrect it from excluded_opportunities.
      assert.ok(!mr.opportunities.some((o) => o.compliance.status === 'BLOCK'));
    });
  });

  // --- Evidence -----------------------------------------------------------------------------

  await testAsync('EVIDENCE: only recorded source URLs are relayed, with their grade and time', async () => {
    clearStore();
    seedResearchRun(['Alpha']);
    await withServer(async (port) => {
      const o = JSON.parse((await authedGet(port, '/overview')).raw).market_research.opportunities[0];
      assert.strictEqual(o.evidence.length, 1);
      assert.strictEqual(o.evidence[0].source_url, 'https://example.test/a');
      assert.strictEqual(o.evidence[0].grade, 'inferred');
      assert.ok(o.evidence[0].retrieved_at);
    });
  });

  // --- Channel isolation ---------------------------------------------------------------------

  await testAsync('CHANNEL: catalogue context is relayed; no opportunity is given an invented channel', async () => {
    clearStore();
    seedResearchRun(['Alpha']);
    await withServer(async (port) => {
      const mr = JSON.parse((await authedGet(port, '/overview')).raw).market_research;
      // The channels the CUSTOMER CONTEXT came from - a real recorded fact.
      assert.deepStrictEqual(mr.market_scope.channels, ['shopify', 'etsy']);
      // The opportunity itself carries no channel, and the relay must not add one.
      assert.strictEqual(mr.opportunities[0].channel, undefined);
      // The run record's own channel stays null - never inferred from the research.
      assert.strictEqual(JSON.parse((await authedGet(port, '/overview')).raw).activity.find((a) => a.run_id === mr.run_id).channel, null);
    });
  });

  // --- No research is ever triggered -----------------------------------------------------------

  await testAsync('NO EXECUTION: loading the Overview never runs the research pipeline', async () => {
    clearStore();
    seedResearchRun(['Alpha']);
    let toolCalls = 0;
    const saved = customerMarketOpportunityTool.runCustomerMarketOpportunityTool;
    customerMarketOpportunityTool.runCustomerMarketOpportunityTool = async () => {
      toolCalls += 1;
      return { status: 'success', result: null, error: null };
    };
    try {
      await withServer(async (port) => {
        await authedGet(port, '/overview');
        await authedGet(port, '/overview');
        await authedGet(port, '/overview');
        assert.strictEqual(toolCalls, 0, 'opening the dashboard must never start market research');
      });
    } finally {
      customerMarketOpportunityTool.runCustomerMarketOpportunityTool = saved;
    }
  });

  // --- Etsy / security -------------------------------------------------------------------------

  await testAsync('SECURITY: the market_research payload carries no credential', async () => {
    clearStore();
    seedResearchRun(['Alpha']);
    await withServer(async (port) => {
      const res = await authedGet(port, '/overview');
      assert.ok(
        !/accessToken|access_token|refresh_token|refreshToken|keystring|shared_secret|sharedSecret|x-api-key|api_key|apiKey|password/i.test(res.raw)
      );
      assert.ok(!res.raw.includes(TEST_API_KEY));
    });
  });

  test('ETSY READ-ONLY: unchanged by this dashboard surface', () => {
    assert.deepStrictEqual([...etsyOAuth.ETSY_REQUIRED_SCOPES].sort(), ['listings_r', 'shops_r']);
    assert.ok(etsyOAuth.ETSY_REQUIRED_SCOPES.every((s) => s.endsWith('_r')));
    assert.strictEqual(etsyClient.canPublish(), false);
    for (const tool of TOOL_REGISTRY.filter((t) => /etsy/i.test(t.id))) {
      assert.strictEqual(tool.operation, 'read', `${tool.id} must be a read`);
    }
  });

  test('NO ETSY WRITE ACTION IN THE UI: the dashboard offers no publish/apply/update control', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
    const js = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'dashboard.js'), 'utf8');
    for (const forbidden of ['Apply Changes', 'Publish to Etsy', 'Update Listing', 'Edit Listing', 'listings_w', 'publishListing']) {
      assert.ok(!html.includes(forbidden), `index.html must not offer "${forbidden}"`);
      assert.ok(!js.includes(forbidden), `dashboard.js must not offer "${forbidden}"`);
    }
    // The frontend posts to no Etsy write endpoint - the only Etsy call it makes is the
    // existing read-only analysis trigger.
    const etsyPosts = (js.match(/apiFetch\('\/etsy\/[^']*'/g) || []);
    assert.deepStrictEqual([...new Set(etsyPosts)], ["apiFetch('/etsy/analyze'"], `unexpected Etsy endpoint use: ${etsyPosts.join(', ')}`);
  });

  test('NO SECOND SCORING ENGINE: the frontend computes no fit, rank or trend of its own', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'dashboard.js'), 'utf8');
    const start = js.indexOf('Top market opportunities');
    const end = js.indexOf('function renderOpportunities');
    const section = js.slice(start, end > start ? end : start + 12000);
    for (const forbidden of ['scoreCustomerFit', 'rankCandidates', 'rankScore', 'hasCatalogueExpansionIntent']) {
      assert.ok(!section.includes(forbidden), `the dashboard must not recompute research logic - found "${forbidden}"`);
    }
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('marketOpportunityDashboard.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main();
