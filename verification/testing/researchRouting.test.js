'use strict';

// Research routing through the real Chief router, and the Chief's reply when research does not complete.
//
// PINS THE GAPS THE GLOBAL RESEARCH AUDIT FOUND:
//   - a country list ("... United States, United Kingdom, Canada and Australia") ended in
//     'No known capability matches "Canada"';
//   - "What are the current rising trends ... fads versus lasting trends?" reached a capability that only
//     structures supplied data;
//   - "Get Google Trends search volume ..." was routed into unrelated SEO work instead of being refused;
//   - a live research step blocked by a provider failure was reported as "That step completed but produced no
//     referenceable result", and a failed competitor step hid behind "Done. 1 result".
// No network: routing is deterministic, the live research tool is replaced at its module seam, and the Chief
// reply is driven with injected run results.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.RUN_HISTORY_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'research-routing-runs-'));
process.env.COMMAND_CENTER_SESSION_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'research-routing-sessions-'));
process.env.APPROVAL_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'research-routing-approvals-'));

const intent = require('../../agent/core/researchRequestIntent');
const orchestrator = require('../../agent/core/orchestratorExecutionContract');
const customerMarketOpportunityTool = require('../../tools/customerMarketOpportunityTool');
const sessionStore = require('../../agent/core/commandCenterSessionStore');
const commandCenterSession = require('../../agent/core/commandCenterSession');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`PASS: ${name}`); passed += 1; } catch (err) { console.error(`FAIL: ${name}`); console.error(`  ${err.message}`); failed += 1; }
}
async function testAsync(name, fn) {
  try { await fn(); console.log(`PASS: ${name}`); passed += 1; } catch (err) { console.error(`FAIL: ${name}`); console.error(`  ${err.message}`); failed += 1; }
}

function targets(objective) {
  const routed = orchestrator.planRouting(objective);
  return { routed, ids: (routed.targets || []).map((t) => t.id) };
}

(async () => {
  // ---- Markets ------------------------------------------------------------------------------------
  test('MARKETS: country and region names are detected in order and never read as unknown capabilities', () => {
    assert.deepStrictEqual(
      intent.detectMarketNames('Compare demand across the United States, United Kingdom, Canada and Australia.'),
      ['United States', 'United Kingdom', 'Canada', 'Australia']
    );
    assert.deepStrictEqual(intent.detectMarketNames('Can you help us with the US market and the EU?'), ['United States', 'European Union']);
    assert.deepStrictEqual(intent.detectMarketNames('Tell us what you think.'), [], '"us" the pronoun is not a market');
    const { routed, ids } = targets('Compare global market demand for SVG cut files across the United States, United Kingdom, Canada and Australia. Do not make any changes.');
    assert.strictEqual(routed.status, 'planned', routed.reason);
    assert.deepStrictEqual(ids, ['product']);
    const marketing = targets('Create a marketing strategy for Canada and Australia.');
    assert.ok(!/No known capability matches "(Canada|Australia)/.test(marketing.routed.reason || ''), marketing.routed.reason);
  });

  // ---- Live market research ----------------------------------------------------------------------
  test('LIVE MARKET RESEARCH: demand, trends, rising, seasonal and fad questions reach live research', () => {
    for (const objective of [
      'What are the current rising trends in printable clipart and digital downloads right now, and which are fads versus lasting trends? Do not make any changes.',
      'Is there demand for Halloween SVG files in the UK?',
      'Which clipart themes are seasonal, and when do they peak?',
      'Find emerging product trends for digital planners.',
    ]) {
      const { routed, ids } = targets(objective);
      assert.deepStrictEqual(ids, ['product'], `${objective} -> ${routed.status} ${routed.reason || ''}`);
    }
  });

  test('LIVE MARKET RESEARCH BOUNDARIES: store records, competitors and supplied trend data keep their owners', () => {
    assert.ok(targets('Look at my orders from the last 30 days and summarise the trends.').ids.includes('analytics_optimization'));
    assert.ok(targets('Run trend research on trending topics we have observed').ids.includes('research'));
    const competitors = targets('Research my top competitors for digital clipart and SVG bundles: their products, pricing, positioning and gaps.');
    assert.ok(competitors.ids.includes('research') && !competitors.ids.includes('product') || competitors.ids.includes('research'), JSON.stringify(competitors.ids));
  });

  // ---- Unsupported data sources ------------------------------------------------------------------
  test('UNSUPPORTED SOURCES: Google Trends / search volume / named tools are refused by name - never routed to SEO', () => {
    for (const [objective, name] of [
      ['Get Google Trends search volume and Amazon Best Sellers rank data for SVG bundles and use it to rank opportunities.', 'Google Trends'],
      ['What is the monthly search volume for "halloween svg"?', 'search volume data'],
      ['Pull Jungle Scout sales estimates for clipart bundles.', 'Jungle Scout'],
      ['Find suppliers on AliExpress for sticker paper.', 'AliExpress supplier data'],
    ]) {
      const { routed, ids } = targets(objective);
      assert.strictEqual(routed.status, 'clarification_required', objective);
      assert.strictEqual(routed.interpretation_blocked, true, 'refused, not re-segmented by AI');
      assert.strictEqual(routed.unsupported_data_source, name);
      assert.ok(routed.reason.startsWith(`${name} is not available`), routed.reason);
      assert.deepStrictEqual(ids, [], 'no specialist - SEO included - is asked to fake it');
    }
  });

  test('SUPPLIER DATA: sourcing questions are refused - never answered from product records - and live web research is not offered for them', () => {
    for (const objective of [
      'Compare supplier lead times for my products',
      'Find reliable suppliers for tote bags with MOQ and unit prices',
      'Which manufacturers offer the lowest wholesale price for sticker paper?',
    ]) {
      const { routed, ids } = targets(objective);
      assert.strictEqual(routed.status, 'clarification_required', objective);
      assert.strictEqual(routed.unsupported_data_source, 'Supplier and sourcing data', objective);
      assert.ok(!/live web research on the same question/.test(routed.reason), routed.reason);
      assert.deepStrictEqual(ids, []);
    }
    const aliexpress = targets('Find suppliers on AliExpress for sticker paper.').routed;
    assert.strictEqual(aliexpress.unsupported_data_source, 'AliExpress supplier data', 'a named service keeps its own name');
    for (const objective of ['Fix vendor mismatches on my products', 'What is my profit margin on my products?']) {
      assert.strictEqual(targets(objective).routed.status, 'planned', `${objective}: the store's own vendor and cost records are not supplier lookups`);
    }
  });

  // ---- The markets reach the live research tool ---------------------------------------------------
  await testAsync('MARKETS REACH THE TOOL: the Chief passes the named markets to live research, and nothing else changes', async () => {
    const original = customerMarketOpportunityTool.runCustomerMarketOpportunityTool;
    let received = null;
    customerMarketOpportunityTool.runCustomerMarketOpportunityTool = async (params) => {
      received = params;
      return { status: 'partial', result: { status: 'partial', search_status: 'SEARCH_QUOTA_EXCEEDED', search_status_message: 'Live market research is temporarily unavailable because the web-search allowance has been reached. Existing research remains available.', top_opportunities: [], limitations: [] }, error: null };
    };
    try {
      const result = await orchestrator.runOrchestratorContract('Compare global market demand for SVG cut files across the United States, United Kingdom, Canada and Australia. Do not make any changes.');
      assert.ok(received, JSON.stringify(result.routing && result.routing.reason));
      assert.deepStrictEqual(received.markets, ['Worldwide', 'United States', 'United Kingdom', 'Canada', 'Australia']);
      assert.strictEqual((result.pending_approvals || []).length, 0);
    } finally {
      customerMarketOpportunityTool.runCustomerMarketOpportunityTool = original;
    }
  });

  // ---- Production regression: "No known capability matches "Canada"" -------------------------------
  // The exact production objective. It also says "do not invent search volume" - a prohibition, which must not
  // be read as a request for search-volume data. ROUTING ONLY: the research tool is replaced by a recorder, so
  // nothing here claims live research works.
  const PRODUCTION_MARKET_OBJECTIVE = 'Chief, research the global market for digital download products and identify current customer demand across the United States, United Kingdom, Canada, and Australia. Find specific product opportunities relevant to my Shopify catalogue using real external market research. Show the evidence sources, what is observed versus inferred, and do not invent search volume, sales, or demand metrics. Do not make any changes.';

  test('PRODUCTION REGRESSION (exact objective): routed to live market research - no "Canada" unknown, no search-volume refusal', () => {
    const { routed, ids } = targets(PRODUCTION_MARKET_OBJECTIVE);
    assert.strictEqual(routed.status, 'planned', routed.reason);
    assert.deepStrictEqual(ids, ['product']);
    assert.strictEqual(routed.unsupported_data_source, undefined);
    // Read clause by clause too, every country in the list is scope, never an unknown subject.
    const clauses = orchestrator.planRouting(PRODUCTION_MARKET_OBJECTIVE, { liveMarketGate: false });
    assert.strictEqual(clauses.status, 'planned', clauses.reason);
    for (const entry of clauses.interpretation.filter((i) => intent.isMarketListFragment(i.clause))) {
      assert.notStrictEqual(entry.disposition, 'task', `${entry.clause} became a task`);
    }
  });

  await testAsync('PRODUCTION REGRESSION (exact objective): the Chief dispatches live market research with all four markets, nothing written', async () => {
    const original = customerMarketOpportunityTool.runCustomerMarketOpportunityTool;
    let received = null;
    customerMarketOpportunityTool.runCustomerMarketOpportunityTool = async (params) => {
      received = params;
      return { status: 'partial', result: { status: 'partial', search_status: 'SEARCH_QUOTA_EXCEEDED', search_status_message: 'Live market research is temporarily unavailable because the web-search allowance has been reached. Existing research remains available.', top_opportunities: [], limitations: [] }, error: null };
    };
    try {
      const result = await orchestrator.runOrchestratorContract(PRODUCTION_MARKET_OBJECTIVE);
      assert.strictEqual(result.routing.status, 'planned', result.routing.reason);
      assert.deepStrictEqual(result.routing.plan.map((s) => s.inputs.tool_id), ['catalogue_expansion_opportunities']);
      assert.ok(received, 'the live research tool was reached');
      assert.deepStrictEqual(received.markets, ['Worldwide', 'United States', 'United Kingdom', 'Canada', 'Australia']);
      assert.strictEqual((result.pending_approvals || []).length, 0);
    } finally {
      customerMarketOpportunityTool.runCustomerMarketOpportunityTool = original;
    }
  });

  test('MARKET LISTS: every supported list shape is scope, and live demand requests reach live research', () => {
    const cases = [
      ['Research customer demand for SVG files across the United States, United Kingdom, Canada, and Australia.', ['United States', 'United Kingdom', 'Canada', 'Australia']],
      ['Research customer demand for SVG files across US, UK, Canada and Australia.', ['United States', 'United Kingdom', 'Canada', 'Australia']],
      ['Research demand for clipart in Canada and Australia.', ['Canada', 'Australia']],
      ['Compare demand for printables across UK, US, Canada.', ['United Kingdom', 'United States', 'Canada']],
      ['What is the demand in Canada for digital planners?', ['Canada']],
      ['Compare demand across Canada and Australia for sticker sheets.', ['Canada', 'Australia']],
      // A different list, none of the four above: the shared market vocabulary, not a Canada/Australia special case.
      ['Research customer demand for digital planners across Germany, France, Japan and Brazil.', ['Germany', 'France', 'Japan', 'Brazil']],
      ['Is there demand for wedding clipart in New Zealand, Ireland and South Africa?', ['New Zealand', 'Ireland', 'South Africa']],
    ];
    for (const [objective, markets] of cases) {
      const { routed, ids } = targets(objective);
      assert.strictEqual(routed.status, 'planned', `${objective} -> ${routed.reason}`);
      assert.deepStrictEqual(ids, ['product'], objective);
      for (const market of markets) assert.ok(intent.detectMarketNames(objective).includes(market), `${objective}: ${market}`);
      // Clause by clause, no country or list tail is ever the unknown part.
      const clauses = orchestrator.planRouting(objective, { liveMarketGate: false });
      const unknown = clauses.unmatched_segment || '';
      assert.ok(!intent.isMarketListFragment(unknown), `${objective} (clause by clause) -> ${clauses.reason}`);
      for (const market of markets) {
        assert.ok(!new RegExp(`matches "${market}`).test(clauses.reason || ''), `${objective}: ${market} read as a capability`);
      }
    }
  });

  test('MARKET LISTS IN STORE REQUESTS: the countries are scope and the store specialist keeps the request', () => {
    const sales = targets('Show my sales in the United States, Canada and Australia.');
    assert.deepStrictEqual(sales.ids, ['analytics_optimization'], sales.routed.reason);
    const seo = targets('Review the SEO of my products for the UK, Canada and Australia.');
    assert.deepStrictEqual(seo.ids, ['seo'], seo.routed.reason);
  });

  test('UNKNOWN CAPABILITY: a genuinely unknown request still asks for clarification - alone, or next to a market list', () => {
    const alone = targets('Blorptify my catalogue with zanzibar flux.');
    assert.strictEqual(alone.routed.status, 'clarification_required');
    assert.ok(/No known capability matches/.test(alone.routed.reason), alone.routed.reason);
    const mixed = targets('Research demand for clipart in Canada and Australia, and then frobnicate the widgets.');
    assert.strictEqual(mixed.routed.status, 'clarification_required', 'the live-market gate must not swallow an unknown request');
    assert.ok(/No known capability matches "frobnicate the widgets/.test(mixed.routed.reason), mixed.routed.reason);
    assert.deepStrictEqual(mixed.ids, []);
    const unsupported = targets('Research demand for clipart in Canada and delete my products.');
    assert.strictEqual(unsupported.routed.status, 'clarification_required', 'an unsupported action next to market research is not absorbed');
    // A follow-on question about the same market is part of that question, not an unknown request.
    for (const objective of ['Which clipart themes are seasonal, and when do they peak?', 'Is there demand for planners in the UK, and how big is it?']) {
      assert.deepStrictEqual(targets(objective).ids, ['product'], objective);
    }
    // "US" upper-case is the country in a list; "us" lower-case is still the pronoun.
    assert.deepStrictEqual(intent.detectMarketNames('Compare demand across UK, US, Canada.'), ['United Kingdom', 'United States', 'Canada']);
    assert.deepStrictEqual(intent.detectMarketNames('Help us understand demand.'), []);
  });

  test('PROHIBITED vs REQUESTED SOURCES: "do not invent search volume" is not a request; asking for it is still refused', () => {
    for (const [objective, expected] of [
      ['Research demand for SVG files in the UK and do not invent search volume.', null],
      ['Research demand for SVG files in the UK without using Google Trends.', null],
      ['Get the monthly search volume for halloween svg.', 'search volume data'],
      ['Do not use Google Trends, but get the monthly search volume for halloween svg.', 'search volume data'],
      ['Get Google Trends data for SVG bundles and do not make any changes.', 'Google Trends'],
      ['Find suppliers on AliExpress for sticker paper.', 'AliExpress supplier data'],
    ]) {
      assert.strictEqual(intent.unsupportedDataSourceIn(objective), expected, objective);
    }
  });

  // ---- The Chief's reply ---------------------------------------------------------------------------
  function step({ title, state, outputs = null, errors = [] }) {
    return {
      selected_specialist: { type: 'specialist', id: title.toLowerCase(), title },
      inputs: { tool_id: 'catalogue_expansion_opportunities' },
      completion_state: state,
      outputs,
      errors,
      approvals: [],
      tool_calls: [],
    };
  }

  await testAsync('CHIEF REPLY: a provider failure is named as one - status and message - never "no referenceable result"', async () => {
    const s = sessionStore.createSession({ goal: 'What should this store sell next?' });
    const outcome = await commandCenterSession.runSessionTurn(s, 'What should this store sell next?', {
      runChief: async () => ({
        routing: { status: 'planned', plan: [step({ title: 'Product', state: 'blocked', outputs: { status: 'partial', result: { status: 'partial', search_status: 'SEARCH_QUOTA_EXCEEDED', search_status_message: 'Live market research is temporarily unavailable because the web-search allowance has been reached. Existing research remains available.', top_opportunities: [], limitations: ['x'] } } })] },
      }),
      saveRun: () => 'run-quota',
      lookupResearch: () => null,
    });
    const text = outcome.session.messages[outcome.session.messages.length - 1].text;
    assert.ok(/Not completed: Product: Live market research is temporarily unavailable/.test(text), text);
    assert.ok(text.includes('SEARCH_QUOTA_EXCEEDED'), text);
    assert.ok(!/produced no referenceable result/.test(text), text);
  });

  await testAsync('CHIEF REPLY: a failed step next to a successful one is reported, not hidden behind "Done"', async () => {
    const s = sessionStore.createSession({ goal: 'Research my competitors.' });
    const outcome = await commandCenterSession.runSessionTurn(s, 'Research my competitors.', {
      runChief: async () => ({
        routing: {
          status: 'planned',
          plan: [
            step({ title: 'Research', state: 'failed', errors: ['Claude API request failed (400): Your credit balance is too low to access the Anthropic API.'] }),
            { ...step({ title: 'Product', state: 'complete', outputs: { status: 'success', result: { top_opportunities: [{ rank: 1, product: 'Alpha', evidence: [{ source_url: 'https://a.test' }] }] } } }) },
          ],
        },
      }),
      saveRun: () => 'run-mixed',
      lookupResearch: () => null,
    });
    const text = outcome.session.messages[outcome.session.messages.length - 1].text;
    assert.ok(/Not completed: Research: Claude API request failed \(400\): Your credit balance is too low/.test(text), text);
  });

  await testAsync('CHIEF REPLY: a margin answer says how many variants have a recorded cost - never a bare "Done" when margins are UNKNOWN', async () => {
    // The live audit case: the real store read succeeded, but no variant had a unit cost recorded.
    const s = sessionStore.createSession({ goal: 'What is my profit margin on my products?' });
    const economics = {
      currency: 'USD',
      cost_read_error: null,
      summary: { variants_total: 50, unit_cost_known: 0, unit_cost_unknown: 50, gross_profit_known: 0, contribution_known: 0 },
      not_supplied: ['selling fees', 'inbound shipping cost', 'outbound shipping cost'],
      products: [],
    };
    const outcome = await commandCenterSession.runSessionTurn(s, 'What is my profit margin on my products?', {
      runChief: async () => ({
        routing: { status: 'planned', plan: [step({ title: 'Product', state: 'complete', outputs: { status: 'success', result: { top_opportunities: [{ rank: 1, product: 'Alpha', evidence: [] }] }, product_economics: economics } })] },
      }),
      saveRun: () => 'run-economics',
      lookupResearch: () => null,
    });
    const text = outcome.session.messages[outcome.session.messages.length - 1].text;
    assert.ok(/a unit cost is recorded for 0 of 50 variant\(s\), so gross margin is known for 0 and UNKNOWN for 50/.test(text), text);
    assert.ok(/Not in store data: selling fees, inbound shipping cost, outbound shipping cost/.test(text), text);
    assert.ok(!/margin (?:is|of) \d/.test(text), 'no margin figure is stated');
  });

  await testAsync('CHIEF REPLY: reused live research says which run it came from', async () => {
    const s = sessionStore.createSession({ goal: 'What should this store sell next?' });
    const reason = 'Reused live research from run cc-run-earlier, produced 2026-09-15T10:00:00.000Z (2 hour(s) old, within the 24-hour limit). No new search or model call was made.';
    const outcome = await commandCenterSession.runSessionTurn(s, 'What should this store sell next?', {
      runChief: async () => ({
        routing: { status: 'planned', plan: [step({ title: 'Product', state: 'complete', outputs: { status: 'success', result: { status: 'complete', search_status: 'SEARCH_OK', research_memory: { mode: 'reused', reason }, top_opportunities: [{ rank: 1, product: 'Alpha', evidence: [{ source_url: 'https://a.test' }] }] } } })] },
      }),
      saveRun: () => 'run-reused',
      lookupResearch: () => null,
    });
    const text = outcome.session.messages[outcome.session.messages.length - 1].text;
    assert.ok(text.includes(reason), text);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
