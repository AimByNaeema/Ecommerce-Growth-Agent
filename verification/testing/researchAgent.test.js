'use strict';

const assert = require('node:assert');
const {
  runMarketResearch,
  runGlobalMarketResearch,
  runCompetitorResearch,
  runTrendResearch,
  runCustomerMarketIntelligence,
  runOpportunityDiscovery,
  runResearch,
  retrieveResearchData,
  analyzeResearchData,
  deriveRecommendations,
} = require('../../agent/core/researchAgent');
const { validateResearchAgentResultShape } = require('../../agent/core/researchAgentResultModel');

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

function assertValid(result) {
  const validation = validateResearchAgentResultShape(result);
  assert.strictEqual(validation.valid, true, `expected valid, got errors: ${validation.errors.join(', ')}`);
}

// --- runMarketResearch ------------------------------------------------------------

test('runMarketResearch requires a non-empty market', () => {
  assert.throws(() => runMarketResearch({}), /requires a non-empty `market`/);
});

test('runMarketResearch composes findings/evidence from supplied content', () => {
  const result = runMarketResearch({
    market: 'European Union',
    demandSignals: ['signal A'],
    trends: ['trend A'],
    evidence: ['source A'],
  });
  assertValid(result);
  assert.strictEqual(result.research_type, 'market_research');
  assert.strictEqual(result.market, 'European Union');
  assert.ok(result.findings.includes('signal A'));
  assert.ok(result.findings.includes('trend A'));
  assert.deepStrictEqual(result.evidence, ['source A']);
  assert.strictEqual(result.specialized_records.length, 1);
});

test('runMarketResearch with no evidence stays unassessed/unverified and reports a limitation', () => {
  const result = runMarketResearch({ market: 'European Union', demandSignals: ['signal A'] });
  assertValid(result);
  assert.strictEqual(result.confidence, 'unassessed');
  assert.strictEqual(result.verification_status, 'unverified');
  assert.ok(result.limitations.some((l) => l.includes('No evidence was supplied for European Union')));
});

test('runMarketResearch never invents recommendations', () => {
  const result = runMarketResearch({ market: 'European Union' });
  assertValid(result);
  assert.deepStrictEqual(result.recommendations, []);
});

test('runMarketResearch passes through caller-supplied recommendations unchanged', () => {
  const result = runMarketResearch({ market: 'European Union', recommendations: ['Consider X'] });
  assertValid(result);
  assert.deepStrictEqual(result.recommendations, ['Consider X']);
});

test('runMarketResearch downgrades an unearned "verified" claim to unverified', () => {
  const result = runMarketResearch({ market: 'European Union', verificationStatus: 'verified' });
  assertValid(result);
  assert.strictEqual(result.verification_status, 'unverified');
  assert.ok(result.limitations.some((l) => l.includes('downgraded to unverified')));
});

test('runMarketResearch honors a "verified" claim when evidence backs it', () => {
  const result = runMarketResearch({
    market: 'European Union',
    evidence: ['source A'],
    verificationStatus: 'verified',
  });
  assertValid(result);
  assert.strictEqual(result.verification_status, 'verified');
});

// --- runGlobalMarketResearch -------------------------------------------------------

test('runGlobalMarketResearch requires a non-empty markets array', () => {
  assert.throws(() => runGlobalMarketResearch({}), /requires a non-empty `markets`/);
});

test('runGlobalMarketResearch produces one specialized record per market entry', () => {
  const result = runGlobalMarketResearch({
    markets: [
      { country: 'DE', market: 'European Union', demandSignals: ['EU signal'] },
      { country: 'US', market: 'North America', demandSignals: ['NA signal'] },
    ],
  });
  assertValid(result);
  assert.strictEqual(result.research_type, 'global_market_research');
  assert.strictEqual(result.specialized_records.length, 2);
  assert.ok(result.findings.includes('EU signal'));
  assert.ok(result.findings.includes('NA signal'));
});

// --- runCompetitorResearch ----------------------------------------------------------

test('runCompetitorResearch requires a non-empty competitors array', () => {
  assert.throws(() => runCompetitorResearch({}), /requires a non-empty `competitors`/);
});

test('runCompetitorResearch requires each entry to have a competitor name', () => {
  assert.throws(
    () => runCompetitorResearch({ competitors: [{ market: 'EU' }] }),
    /requires a non-empty `competitor`/
  );
});

test('runCompetitorResearch composes strengths/weaknesses into findings and source', () => {
  const result = runCompetitorResearch({
    competitors: [
      { competitor: '(Example Co.)', strengths: ['fast shipping'], source: ['listing page'] },
    ],
  });
  assertValid(result);
  assert.ok(result.findings.includes('fast shipping'));
  assert.deepStrictEqual(result.source, ['listing page']);
});

// --- runTrendResearch ---------------------------------------------------------------

test('runTrendResearch requires a non-empty trends array', () => {
  assert.throws(() => runTrendResearch({}), /requires a non-empty `trends`/);
});

test('runTrendResearch requires each entry to have a topic', () => {
  assert.throws(
    () => runTrendResearch({ trends: [{ finding: 'no topic here' }] }),
    /requires a non-empty `topic`/
  );
});

test('runTrendResearch composes one generic record per topic', () => {
  const result = runTrendResearch({
    trends: [
      { topic: 'Trend A', finding: 'finding A' },
      { topic: 'Trend B', finding: 'finding B' },
    ],
  });
  assertValid(result);
  assert.strictEqual(result.research_type, 'trend_research');
  assert.strictEqual(result.specialized_records.length, 2);
  assert.deepStrictEqual(result.findings, ['finding A', 'finding B']);
});

// --- runCustomerMarketIntelligence ---------------------------------------------------

test('runCustomerMarketIntelligence requires a non-empty segments array', () => {
  assert.throws(() => runCustomerMarketIntelligence({}), /requires a non-empty `segments`/);
});

test('runCustomerMarketIntelligence requires each entry to have a segmentDefinition', () => {
  assert.throws(
    () => runCustomerMarketIntelligence({ segments: [{ needs: ['x'] }] }),
    /requires a non-empty `segmentDefinition`/
  );
});

test('runCustomerMarketIntelligence composes needs/problems into findings', () => {
  const result = runCustomerMarketIntelligence({
    segments: [{ segmentDefinition: 'Budget shoppers', needs: ['low price'], evidence: ['survey'] }],
  });
  assertValid(result);
  assert.ok(result.findings.includes('low price'));
  assert.deepStrictEqual(result.evidence, ['survey']);
});

// --- runOpportunityDiscovery ---------------------------------------------------------

test('runOpportunityDiscovery requires a non-empty signals array', () => {
  assert.throws(() => runOpportunityDiscovery({}), /requires a non-empty `signals`/);
});

test('runOpportunityDiscovery composes one generic record per signal', () => {
  const result = runOpportunityDiscovery({
    signals: [{ topic: 'Underserved segment', finding: 'gap identified' }],
  });
  assertValid(result);
  assert.strictEqual(result.research_type, 'opportunity_discovery');
  assert.ok(result.findings.includes('gap identified'));
});

// --- runResearch dispatcher ----------------------------------------------------------

test('runResearch dispatches market_research to runMarketResearch', () => {
  const result = runResearch({ researchType: 'market_research', market: 'European Union' });
  assertValid(result);
  assert.strictEqual(result.research_type, 'market_research');
});

test('runResearch dispatches opportunity_discovery to runOpportunityDiscovery', () => {
  const result = runResearch({
    researchType: 'opportunity_discovery',
    signals: [{ topic: 'Gap', finding: 'finding' }],
  });
  assertValid(result);
  assert.strictEqual(result.research_type, 'opportunity_discovery');
});

test('runResearch rejects an unknown research type', () => {
  assert.throws(() => runResearch({ researchType: 'not_a_real_type' }), /Unknown research type/);
});

// --- retrieveResearchData (data retrieval stage) --------------------------------------

test('retrieveResearchData builds one validated record per entry, by kind', () => {
  const records = retrieveResearchData(
    'market',
    [{ market: 'European Union', demandSignals: ['x'] }],
    'test'
  );
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].market, 'European Union');
});

test('retrieveResearchData throws for an unknown kind', () => {
  assert.throws(
    () => retrieveResearchData('not_a_real_kind', [{}], 'test'),
    /unknown record kind/
  );
});

test('retrieveResearchData propagates the underlying builder\'s required-field error', () => {
  assert.throws(
    () => retrieveResearchData('market', [{ demandSignals: ['x'] }], 'test'),
    /requires a non-empty `market`/
  );
});

// --- analyzeResearchData (analysis stage) ----------------------------------------------

test('analyzeResearchData flattens findings/evidence/source across records', () => {
  const records = retrieveResearchData(
    'competitor',
    [{ competitor: 'A', strengths: ['fast'], source: ['s1'] }],
    'test'
  );
  const analysis = analyzeResearchData(records, 'competitor');
  assert.deepStrictEqual(analysis.findings, ['fast']);
  assert.deepStrictEqual(analysis.source, ['s1']);
  assert.strictEqual(analysis.anyEvidenceSupplied, true);
});

test('analyzeResearchData reports a limitation and anyEvidenceSupplied=false when nothing is evidenced', () => {
  const records = retrieveResearchData('competitor', [{ competitor: 'A', strengths: ['fast'] }], 'test');
  const analysis = analyzeResearchData(records, 'competitor');
  assert.strictEqual(analysis.anyEvidenceSupplied, false);
  assert.ok(analysis.limitations.some((l) => l.includes('No evidence was supplied for A')));
});

test('analyzeResearchData reports mixed evidence across multiple records honestly', () => {
  const records = retrieveResearchData(
    'competitor',
    [
      { competitor: 'A', strengths: ['fast'] },
      { competitor: 'B', strengths: ['cheap'], source: ['s1'] },
    ],
    'test'
  );
  const analysis = analyzeResearchData(records, 'competitor');
  assert.strictEqual(analysis.anyEvidenceSupplied, true);
  assert.ok(analysis.limitations.some((l) => l.includes('No evidence was supplied for A')));
  assert.ok(!analysis.limitations.some((l) => l.includes('No evidence was supplied for B')));
});

test('analyzeResearchData throws for an unknown kind', () => {
  assert.throws(() => analyzeResearchData([], 'not_a_real_kind'), /unknown record kind/);
});

// --- deriveRecommendations (recommendation stage) ---------------------------------------

test('deriveRecommendations passes through caller-supplied recommendations unchanged', () => {
  assert.deepStrictEqual(deriveRecommendations(['Consider X']), ['Consider X']);
});

test('deriveRecommendations never invents a recommendation when none is supplied', () => {
  assert.deepStrictEqual(deriveRecommendations(undefined), []);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
