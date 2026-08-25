'use strict';

const assert = require('node:assert');
const { rankGrowthOpportunities } = require('../../agent/core/growthOpportunityEngine');

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

function baseCandidate(overrides = {}) {
  return {
    category: 'seo',
    opportunity: '(example opportunity)',
    reason: '(example reason)',
    evidence: ['(example evidence)'],
    expectedImpactCategory: 'traffic_visibility',
    expectedImpactMagnitude: 3,
    confidence: 'medium',
    requiredAction: '(example required action)',
    actionClassification: 'recommendation',
    ...overrides,
  };
}

test('empty input returns a valid, honest empty result, not an error', () => {
  const result = rankGrowthOpportunities([]);
  assert.strictEqual(result.total_opportunities, 0);
  assert.deepStrictEqual(result.opportunities, []);
  assert.ok(result.methodology.includes('rank_score'));
});

test('throws when candidates is not an array', () => {
  assert.throws(() => rankGrowthOpportunities('not an array'), /requires `candidates` to be an array/);
});

test('throws on an invalid category', () => {
  assert.throws(
    () => rankGrowthOpportunities([baseCandidate({ category: 'not_a_real_category' })]),
    /candidates\[0\]\.category` to be one of/
  );
});

test('throws on a missing opportunity string', () => {
  assert.throws(
    () => rankGrowthOpportunities([baseCandidate({ opportunity: '' })]),
    /non-empty `candidates\[0\]\.opportunity`/
  );
});

test('throws on a missing reason string', () => {
  assert.throws(() => rankGrowthOpportunities([baseCandidate({ reason: '' })]), /non-empty `candidates\[0\]\.reason`/);
});

test('throws on a missing requiredAction string', () => {
  assert.throws(
    () => rankGrowthOpportunities([baseCandidate({ requiredAction: '' })]),
    /non-empty `candidates\[0\]\.requiredAction`/
  );
});

test('throws on an invalid expectedImpactCategory', () => {
  assert.throws(
    () => rankGrowthOpportunities([baseCandidate({ expectedImpactCategory: 'not_real' })]),
    /candidates\[0\]\.expectedImpactCategory` to be one of/
  );
});

test('throws when expectedImpactMagnitude is missing', () => {
  assert.throws(
    () => rankGrowthOpportunities([baseCandidate({ expectedImpactMagnitude: undefined })]),
    /expectedImpactMagnitude to be a finite number between 1 and 5/
  );
});

test('throws when expectedImpactMagnitude is out of range', () => {
  assert.throws(
    () => rankGrowthOpportunities([baseCandidate({ expectedImpactMagnitude: 6 })]),
    /expectedImpactMagnitude to be a finite number between 1 and 5/
  );
  assert.throws(
    () => rankGrowthOpportunities([baseCandidate({ expectedImpactMagnitude: 0 })]),
    /expectedImpactMagnitude to be a finite number between 1 and 5/
  );
});

test('throws on an unrecognized actionClassification', () => {
  assert.throws(
    () => rankGrowthOpportunities([baseCandidate({ actionClassification: 'not_a_real_classification' })]),
    /actionClassification to resolve to a real approvals\/approvalArchitecture\.js classification id/
  );
});

test('honesty guard: confidence is forced to unassessed when evidence is empty', () => {
  const result = rankGrowthOpportunities([baseCandidate({ confidence: 'high', evidence: [] })]);
  assert.strictEqual(result.opportunities[0].confidence, 'unassessed');
  assert.strictEqual(result.opportunities[0].rank_score, 0);
});

test('honesty guard: confidence is preserved when evidence is present', () => {
  const result = rankGrowthOpportunities([baseCandidate({ confidence: 'high', evidence: ['x'] })]);
  assert.strictEqual(result.opportunities[0].confidence, 'high');
});

test('honesty guard: verified status is downgraded to unverified when evidence is empty', () => {
  const result = rankGrowthOpportunities([baseCandidate({ verificationStatus: 'verified', evidence: [] })]);
  assert.strictEqual(result.opportunities[0].verification_status, 'unverified');
});

test('honesty guard: verified status is preserved when evidence is present', () => {
  const result = rankGrowthOpportunities([baseCandidate({ verificationStatus: 'verified', evidence: ['x'] })]);
  assert.strictEqual(result.opportunities[0].verification_status, 'verified');
});

test('rank_score is expected_impact_magnitude x confidence multiplier', () => {
  const result = rankGrowthOpportunities([baseCandidate({ expectedImpactMagnitude: 5, confidence: 'high', evidence: ['x'] })]);
  assert.strictEqual(result.opportunities[0].rank_score, 5);

  const medium = rankGrowthOpportunities([baseCandidate({ expectedImpactMagnitude: 4, confidence: 'medium', evidence: ['x'] })]);
  assert.ok(Math.abs(medium.opportunities[0].rank_score - 4 * 0.66) < 1e-9);
});

test('sorts descending by rank_score and assigns 1-based rank', () => {
  const result = rankGrowthOpportunities([
    baseCandidate({ opportunity: 'low', expectedImpactMagnitude: 1, confidence: 'low', evidence: ['x'] }),
    baseCandidate({ opportunity: 'high', expectedImpactMagnitude: 5, confidence: 'high', evidence: ['x'] }),
    baseCandidate({ opportunity: 'medium', expectedImpactMagnitude: 3, confidence: 'medium', evidence: ['x'] }),
  ]);
  assert.deepStrictEqual(
    result.opportunities.map((o) => o.opportunity),
    ['high', 'medium', 'low']
  );
  assert.deepStrictEqual(
    result.opportunities.map((o) => o.rank),
    [1, 2, 3]
  );
});

test('tie-break: equal rank_score is broken by evidence count (desc)', () => {
  const result = rankGrowthOpportunities([
    baseCandidate({ opportunity: 'fewer-evidence', expectedImpactMagnitude: 3, confidence: 'high', evidence: ['a'] }),
    baseCandidate({ opportunity: 'more-evidence', expectedImpactMagnitude: 3, confidence: 'high', evidence: ['a', 'b', 'c'] }),
  ]);
  assert.deepStrictEqual(
    result.opportunities.map((o) => o.opportunity),
    ['more-evidence', 'fewer-evidence']
  );
});

test('tie-break: equal rank_score and evidence count is broken by category (alphabetical)', () => {
  const result = rankGrowthOpportunities([
    baseCandidate({ category: 'social', opportunity: 'social-opp', expectedImpactMagnitude: 2, confidence: 'medium', evidence: ['a'] }),
    baseCandidate({ category: 'listings', opportunity: 'listings-opp', expectedImpactMagnitude: 2, confidence: 'medium', evidence: ['a'] }),
  ]);
  assert.deepStrictEqual(
    result.opportunities.map((o) => o.category),
    ['listings', 'social']
  );
});

test('tie-break: fully equal candidates preserve original input order', () => {
  const result = rankGrowthOpportunities([
    baseCandidate({ opportunity: 'first' }),
    baseCandidate({ opportunity: 'second' }),
  ]);
  assert.deepStrictEqual(
    result.opportunities.map((o) => o.opportunity),
    ['first', 'second']
  );
});

test('approval_requirement.requires_human_approval is false for analysis_only and recommendation', () => {
  const analysisOnly = rankGrowthOpportunities([baseCandidate({ actionClassification: 'analysis_only' })]);
  const recommendation = rankGrowthOpportunities([baseCandidate({ actionClassification: 'recommendation' })]);
  assert.strictEqual(analysisOnly.opportunities[0].approval_requirement.requires_human_approval, false);
  assert.strictEqual(recommendation.opportunities[0].approval_requirement.requires_human_approval, false);
});

test('approval_requirement.requires_human_approval is true for approval_required and externally_executable', () => {
  const approvalRequired = rankGrowthOpportunities([baseCandidate({ actionClassification: 'approval_required' })]);
  const externallyExecutable = rankGrowthOpportunities([baseCandidate({ actionClassification: 'externally_executable' })]);
  assert.strictEqual(approvalRequired.opportunities[0].approval_requirement.requires_human_approval, true);
  assert.strictEqual(externallyExecutable.opportunities[0].approval_requirement.requires_human_approval, true);
});

test('approval_requirement carries the real classification title/description, not invented text', () => {
  const result = rankGrowthOpportunities([baseCandidate({ actionClassification: 'externally_executable' })]);
  const requirement = result.opportunities[0].approval_requirement;
  assert.strictEqual(requirement.classification, 'externally_executable');
  assert.strictEqual(requirement.title, 'Externally executable');
  assert.ok(requirement.description.includes('call or change an external system'));
});

test('never invents opportunity, reason, evidence, or required_action - relays exactly what was supplied', () => {
  const result = rankGrowthOpportunities([
    baseCandidate({
      opportunity: 'Exact opportunity text',
      reason: 'Exact reason text',
      evidence: ['Exact evidence entry'],
      requiredAction: 'Exact required action text',
    }),
  ]);
  const record = result.opportunities[0];
  assert.strictEqual(record.opportunity, 'Exact opportunity text');
  assert.strictEqual(record.reason, 'Exact reason text');
  assert.deepStrictEqual(record.evidence, ['Exact evidence entry']);
  assert.strictEqual(record.required_action, 'Exact required action text');
});

test('methodology field documents the exact ranking formula', () => {
  const result = rankGrowthOpportunities([baseCandidate()]);
  assert.ok(result.methodology.includes('expected_impact_magnitude'));
  assert.ok(result.methodology.includes('confidence_multiplier'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
