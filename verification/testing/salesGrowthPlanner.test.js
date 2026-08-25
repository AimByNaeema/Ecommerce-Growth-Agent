'use strict';

const assert = require('node:assert');
const { generateSalesGrowthPlan } = require('../../agent/core/salesGrowthPlanner');
const {
  SALES_GROWTH_PLAN_DOMAINS,
  validateSalesGrowthPlanShape,
} = require('../../agent/core/salesGrowthPlanModel');

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
  const validation = validateSalesGrowthPlanShape(result);
  assert.strictEqual(validation.valid, true, `expected valid, got errors: ${validation.errors.join(', ')}`);
}

// --- baseline: nothing supplied stays honestly empty, never fabricated -----------------

test('calling with no evidence reports every domain empty and 0% coverage, never fabricated', () => {
  const result = generateSalesGrowthPlan({ subjectReference: '(no evidence)' });
  assertValid(result);
  for (const status of Object.values(result.domain_status)) {
    assert.strictEqual(status, 'empty');
  }
  assert.strictEqual(result.domain_coverage.percentage, 0);
  assert.strictEqual(result.domain_coverage.status, 'empty');
  assert.strictEqual(result.domain_gaps.length, SALES_GROWTH_PLAN_DOMAINS.length);
  assert.deepStrictEqual(result.bottlenecks, []);
  assert.deepStrictEqual(result.opportunities, []);
  assert.deepStrictEqual(result.recommended_actions, []);
  assert.deepStrictEqual(result.kpis, []);
  assert.deepStrictEqual(result.experiment_ideas, []);
  assert.deepStrictEqual(result.approval_requirements, []);
});

test('subject_reference is echoed exactly as supplied', () => {
  const result = generateSalesGrowthPlan({ subjectReference: 'Acme Store' });
  assert.strictEqual(result.subject_reference, 'Acme Store');
});

test('plan_date is set to today in ISO format', () => {
  const result = generateSalesGrowthPlan({ subjectReference: 'x' });
  const today = new Date().toISOString().slice(0, 10);
  assert.strictEqual(result.plan_date, today);
});

// --- current_state / domain_status per domain -------------------------------------------

test('a domain with only a summary supplied is partial, not success', () => {
  const result = generateSalesGrowthPlan({ subjectReference: 'x', seo: { summary: 'Organic traffic down.' } });
  assert.strictEqual(result.domain_status.seo, 'partial');
  assert.strictEqual(result.current_state.seo.summary, 'Organic traffic down.');
});

test('a domain with only metrics supplied is partial, not success', () => {
  const result = generateSalesGrowthPlan({ subjectReference: 'x', analytics: { actualMetrics: [{ metric: 'conversion_rate', value: '1.9%' }] } });
  assert.strictEqual(result.domain_status.analytics, 'partial');
  assert.deepStrictEqual(result.current_state.analytics.actual_metrics, [{ metric: 'conversion_rate', value: '1.9%' }]);
});

test('a domain with both summary and metrics supplied is success', () => {
  const result = generateSalesGrowthPlan({
    subjectReference: 'x',
    product: { summary: '120 active SKUs.', actualMetrics: [{ metric: 'active_skus', value: 120 }] },
  });
  assert.strictEqual(result.domain_status.product, 'success');
  assert.ok(!result.domain_gaps.some((gap) => gap.domain === 'product'));
});

test('all 7 domains can be supplied independently and are echoed correctly', () => {
  const result = generateSalesGrowthPlan({
    subjectReference: 'x',
    product: { summary: 'p' },
    customer: { summary: 'c' },
    analytics: { summary: 'a' },
    seo: { summary: 's' },
    marketing: { summary: 'm' },
    social: { summary: 'so' },
    advertising: { summary: 'ad' },
  });
  for (const domain of SALES_GROWTH_PLAN_DOMAINS) {
    assert.strictEqual(result.domain_status[domain], 'partial');
  }
  assert.strictEqual(result.domain_coverage.domains_partial, 7);
  assert.strictEqual(result.domain_coverage.domains_success, 0);
});

// --- bottlenecks + honesty guard ----------------------------------------------------------

test('a bottleneck with evidence keeps its asserted severity', () => {
  const result = generateSalesGrowthPlan({
    subjectReference: 'x',
    bottlenecks: [{ domain: 'analytics', description: 'High mobile abandonment.', evidence: ['funnel report'], severity: 'critical' }],
  });
  assert.strictEqual(result.bottlenecks[0].severity, 'critical');
  assert.strictEqual(result.limitations.length, 0);
});

test('a bottleneck asserted critical with no evidence is downgraded to medium and recorded', () => {
  const result = generateSalesGrowthPlan({
    subjectReference: 'x',
    bottlenecks: [{ domain: 'seo', description: 'Declining traffic.', evidence: [], severity: 'critical' }],
  });
  assert.strictEqual(result.bottlenecks[0].severity, 'medium');
  assert.strictEqual(result.limitations.length, 1);
  assert.ok(result.limitations[0].includes('downgraded to \'medium\''));
});

test('a bottleneck asserted high with no evidence is downgraded to medium', () => {
  const result = generateSalesGrowthPlan({
    subjectReference: 'x',
    bottlenecks: [{ domain: 'marketing', description: 'Weak campaign ROI.', evidence: [], severity: 'high' }],
  });
  assert.strictEqual(result.bottlenecks[0].severity, 'medium');
});

test('a bottleneck asserted low with no evidence is not downgraded (already at the floor)', () => {
  const result = generateSalesGrowthPlan({
    subjectReference: 'x',
    bottlenecks: [{ domain: 'marketing', description: 'Minor copy inconsistency.', evidence: [], severity: 'low' }],
  });
  assert.strictEqual(result.bottlenecks[0].severity, 'low');
  assert.strictEqual(result.limitations.length, 0);
});

test('a bottleneck with an invalid domain throws rather than silently accepting it', () => {
  assert.throws(() => {
    generateSalesGrowthPlan({
      subjectReference: 'x',
      bottlenecks: [{ domain: 'not_a_real_domain', description: 'x', evidence: [], severity: 'low' }],
    });
  }, /to be one of/);
});

// --- opportunities (delegated to growthOpportunityEngine.js) -----------------------------

test('opportunities are ranked via the Growth Opportunity Engine, not reimplemented', () => {
  const result = generateSalesGrowthPlan({
    subjectReference: 'x',
    opportunityCandidates: [
      {
        category: 'seo',
        opportunity: 'Recover lost rankings.',
        reason: 'Traffic decline coincides with a ranking drop.',
        evidence: ['rank report'],
        expectedImpactCategory: 'traffic_visibility',
        expectedImpactMagnitude: 4,
        confidence: 'high',
        requiredAction: 'Refresh on-page SEO.',
        actionClassification: 'recommendation',
      },
    ],
  });
  assert.strictEqual(result.opportunities.length, 1);
  assert.strictEqual(result.opportunities[0].rank, 1);
  assert.strictEqual(result.opportunities[0].rank_score, 4);
});

test('an invalid opportunity candidate throws (delegated validation from growthOpportunityEngine.js)', () => {
  assert.throws(() => {
    generateSalesGrowthPlan({ subjectReference: 'x', opportunityCandidates: [{ category: 'not_real' }] });
  });
});

// --- recommended_actions + approval tagging -----------------------------------------------

test('a recommended action requires a resolvable actionClassification', () => {
  assert.throws(() => {
    generateSalesGrowthPlan({
      subjectReference: 'x',
      recommendedActions: [{ domain: 'seo', action: 'x', rationale: 'x', actionClassification: 'not_a_real_classification' }],
    });
  }, /to resolve to a real/);
});

test('a recommended action tagged analysis_only does not require human approval', () => {
  const result = generateSalesGrowthPlan({
    subjectReference: 'x',
    recommendedActions: [{ domain: 'analytics', action: 'Review the funnel report.', rationale: 'x', actionClassification: 'analysis_only' }],
  });
  assert.strictEqual(result.recommended_actions[0].approval_requirement.requires_human_approval, false);
});

test('a recommended action tagged approval_required does require human approval', () => {
  const result = generateSalesGrowthPlan({
    subjectReference: 'x',
    recommendedActions: [{ domain: 'analytics', action: 'Change the checkout flow.', rationale: 'x', actionClassification: 'approval_required' }],
  });
  assert.strictEqual(result.recommended_actions[0].approval_requirement.requires_human_approval, true);
});

// --- kpis / experiment_ideas: caller-supplied, structured only ---------------------------

test('kpis are relayed exactly as supplied, never an invented target', () => {
  const result = generateSalesGrowthPlan({
    subjectReference: 'x',
    kpis: [{ domain: 'analytics', metric: 'conversion_rate', currentValue: '1.9%', targetValue: '2.5%', rationale: 'x' }],
  });
  assert.deepStrictEqual(result.kpis[0], {
    domain: 'analytics',
    metric: 'conversion_rate',
    current_value: '1.9%',
    target_value: '2.5%',
    rationale: 'x',
  });
});

test('experiment ideas are relayed exactly as supplied, never invented from nothing', () => {
  const result = generateSalesGrowthPlan({
    subjectReference: 'x',
    experimentIdeas: [{ domain: 'seo', hypothesis: 'h', testDescription: 't', expectedOutcome: 'e', evidence: ['x'] }],
  });
  assert.deepStrictEqual(result.experiment_ideas[0], {
    domain: 'seo',
    hypothesis: 'h',
    test_description: 't',
    expected_outcome: 'e',
    evidence: ['x'],
  });
});

// --- approval_requirements rollup ---------------------------------------------------------

test('approval_requirements rolls up requires_human_approval items from both opportunities and recommended_actions', () => {
  const result = generateSalesGrowthPlan({
    subjectReference: 'x',
    opportunityCandidates: [
      {
        category: 'advertising',
        opportunity: 'Increase ad budget.',
        reason: 'High ROAS ad set.',
        evidence: [],
        expectedImpactCategory: 'revenue',
        expectedImpactMagnitude: 5,
        confidence: 'high',
        requiredAction: 'Increase daily budget.',
        actionClassification: 'externally_executable',
      },
    ],
    recommendedActions: [
      { domain: 'analytics', action: 'Change checkout flow.', rationale: 'x', actionClassification: 'approval_required' },
      { domain: 'seo', action: 'Publish a blog post.', rationale: 'x', actionClassification: 'analysis_only' },
    ],
  });
  assert.strictEqual(result.approval_requirements.length, 2);
  assert.ok(result.approval_requirements.every((entry) => entry.requires_human_approval === true));
  assert.deepStrictEqual(
    result.approval_requirements.map((entry) => entry.source).sort(),
    ['opportunity', 'recommended_action']
  );
});

test('approval_requirements excludes items that do not require human approval', () => {
  const result = generateSalesGrowthPlan({
    subjectReference: 'x',
    recommendedActions: [{ domain: 'seo', action: 'Review a report.', rationale: 'x', actionClassification: 'analysis_only' }],
  });
  assert.deepStrictEqual(result.approval_requirements, []);
});

// --- honesty / determinism ----------------------------------------------------------------

test('no fabricated revenue/growth-rate prediction appears anywhere in the serialized result', () => {
  const result = generateSalesGrowthPlan({
    subjectReference: 'x',
    product: { summary: '120 active SKUs.' },
  });
  const serialized = JSON.stringify(result);
  assert.ok(!/projected|forecast|will increase by/i.test(serialized));
});

test('calling twice with the same input produces a deep-equal result except plan_date', () => {
  const input = {
    subjectReference: 'x',
    seo: { summary: 'Organic traffic down.' },
    bottlenecks: [{ domain: 'seo', description: 'x', evidence: [], severity: 'low' }],
  };
  const first = generateSalesGrowthPlan(input);
  const second = generateSalesGrowthPlan(input);
  assert.deepStrictEqual(first, second);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
