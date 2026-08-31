'use strict';

const assert = require('node:assert');
const {
  rankGrowthOpportunities,
  rankAvailableGrowthOpportunities,
  applyGrowthOpportunityOverrides,
} = require('../../agent/core/growthOpportunityEngine');

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

// --- rankAvailableGrowthOpportunities ------------------------------------------------

test('rankAvailableGrowthOpportunities: mixed complete + incomplete candidates ranks the complete one and honestly reports the rest', () => {
  const complete = baseCandidate({ opportunity: 'complete-one' });
  const incomplete = { category: 'seo', opportunity: 'incomplete-one', reason: '(example reason)' };

  const result = rankAvailableGrowthOpportunities([complete, incomplete]);

  assert.strictEqual(result.total_candidates, 2);
  assert.strictEqual(result.ranked.length, 1);
  assert.strictEqual(result.ranked[0].opportunity, 'complete-one');
  assert.strictEqual(result.ranked[0].rank, 1);

  assert.strictEqual(result.unranked.length, 1);
  assert.strictEqual(result.unranked[0].index, 1);
  assert.strictEqual(result.unranked[0].candidate.opportunity, 'incomplete-one');
  assert.deepStrictEqual(result.unranked[0].missing_fields, [
    'requiredAction',
    'expectedImpactCategory',
    'expectedImpactMagnitude',
    'actionClassification',
  ]);

  assert.strictEqual(result.limitations.length, 1);
  assert.ok(result.limitations[0].includes('1 of 2'));
  assert.ok(result.limitations[0].includes('Nothing was invented or defaulted'));
});

test('rankAvailableGrowthOpportunities: all-incomplete candidates ranks nothing and never invents a winner', () => {
  const result = rankAvailableGrowthOpportunities([
    { category: 'seo', opportunity: 'a' },
    { category: 'listings', opportunity: 'b', reason: 'r' },
  ]);
  assert.strictEqual(result.ranked.length, 0);
  assert.strictEqual(result.unranked.length, 2);
  assert.ok(result.limitations[0].includes('2 of 2'));
});

test('rankAvailableGrowthOpportunities: zero candidates returns an honest empty result, not an error', () => {
  const result = rankAvailableGrowthOpportunities([]);
  assert.strictEqual(result.total_candidates, 0);
  assert.deepStrictEqual(result.ranked, []);
  assert.deepStrictEqual(result.unranked, []);
  assert.deepStrictEqual(result.limitations, ['No candidates were supplied - nothing to rank.']);
});

test('rankAvailableGrowthOpportunities: never invents expectedImpactMagnitude or actionClassification for an incomplete candidate', () => {
  const result = rankAvailableGrowthOpportunities([
    { category: 'seo', opportunity: 'a', reason: 'r', requiredAction: 'do it', expectedImpactCategory: 'revenue' },
  ]);
  assert.strictEqual(result.ranked.length, 0);
  assert.deepStrictEqual(result.unranked[0].missing_fields, ['expectedImpactMagnitude', 'actionClassification']);
  // the candidate itself is relayed exactly as supplied - no field was added or guessed
  assert.strictEqual('expectedImpactMagnitude' in result.unranked[0].candidate, false);
  assert.strictEqual('actionClassification' in result.unranked[0].candidate, false);
});

test('rankAvailableGrowthOpportunities: throws when candidates is not an array (same contract as rankGrowthOpportunities)', () => {
  assert.throws(() => rankAvailableGrowthOpportunities('nope'), /requires `candidates` to be an array/);
});

test('rankAvailableGrowthOpportunities: identical ready candidates produce the exact same ranked output as rankGrowthOpportunities', () => {
  const candidates = [
    baseCandidate({ opportunity: 'high', expectedImpactMagnitude: 5, confidence: 'high', evidence: ['x'] }),
    baseCandidate({ opportunity: 'low', expectedImpactMagnitude: 1, confidence: 'low', evidence: ['x'] }),
  ];
  const direct = rankGrowthOpportunities(candidates);
  const wrapped = rankAvailableGrowthOpportunities(candidates);
  assert.deepStrictEqual(wrapped.ranked, direct.opportunities);
  assert.deepStrictEqual(wrapped.unranked, []);
});

// --- applyGrowthOpportunityOverrides ------------------------------------------------

function sampleDraft(overrides = {}) {
  return {
    opportunity: 'Insulated Jacket: Send a win-back email.',
    category: 'retention',
    reason: 'Segment: Lapsed customers; Offer: 15% off',
    evidence: ['(placeholder evidence)'],
    requiredAction: 'Send a win-back email.',
    verificationStatus: 'unverified',
    missing_for_ranking: ['expectedImpactCategory', 'expectedImpactMagnitude', 'actionClassification'],
    ...overrides,
  };
}

test('applyGrowthOpportunityOverrides: fills only the judgment fields the caller supplied', () => {
  const drafts = [sampleDraft()];
  const merged = applyGrowthOpportunityOverrides(drafts, {
    'Insulated Jacket: Send a win-back email.': {
      expectedImpactCategory: 'customer_retention',
      expectedImpactMagnitude: 3,
      actionClassification: 'approval_required',
    },
  });
  assert.strictEqual(merged[0].expectedImpactCategory, 'customer_retention');
  assert.strictEqual(merged[0].expectedImpactMagnitude, 3);
  assert.strictEqual(merged[0].actionClassification, 'approval_required');
});

test('applyGrowthOpportunityOverrides: never overwrites real draft evidence/opportunity/reason/requiredAction even if an override tries to', () => {
  const drafts = [sampleDraft()];
  const merged = applyGrowthOpportunityOverrides(drafts, {
    'Insulated Jacket: Send a win-back email.': {
      opportunity: 'HIJACKED',
      reason: 'HIJACKED',
      evidence: ['HIJACKED'],
      requiredAction: 'HIJACKED',
      expectedImpactMagnitude: 3,
    },
  });
  assert.strictEqual(merged[0].opportunity, 'Insulated Jacket: Send a win-back email.');
  assert.strictEqual(merged[0].reason, 'Segment: Lapsed customers; Offer: 15% off');
  assert.deepStrictEqual(merged[0].evidence, ['(placeholder evidence)']);
  assert.strictEqual(merged[0].requiredAction, 'Send a win-back email.');
  assert.strictEqual(merged[0].expectedImpactMagnitude, 3);
});

test('applyGrowthOpportunityOverrides: never invents a value for a draft with no matching override', () => {
  const drafts = [sampleDraft()];
  const merged = applyGrowthOpportunityOverrides(drafts, {});
  assert.strictEqual('expectedImpactMagnitude' in merged[0], false);
  assert.strictEqual('actionClassification' in merged[0], false);
});

test('applyGrowthOpportunityOverrides: a partial override fills only the fields it names, leaving the rest missing', () => {
  const drafts = [sampleDraft()];
  const merged = applyGrowthOpportunityOverrides(drafts, {
    'Insulated Jacket: Send a win-back email.': { expectedImpactMagnitude: 3 },
  });
  assert.strictEqual(merged[0].expectedImpactMagnitude, 3);
  assert.strictEqual('actionClassification' in merged[0], false);
  assert.strictEqual('expectedImpactCategory' in merged[0], false);
});

test('applyGrowthOpportunityOverrides: throws when drafts is not an array', () => {
  assert.throws(() => applyGrowthOpportunityOverrides('nope', {}), /requires `drafts` to be an array/);
});

// --- end-to-end: real draft-shaped records + explicit overrides -> partial ranking ---

test('end-to-end: a real draft with an explicit override ranks, and an unmatched real draft stays honestly unranked', () => {
  const rankedDraft = sampleDraft();
  const unmatchedDraft = sampleDraft({
    opportunity: 'Wool Hat: Cross-sell with jacket purchases.',
    requiredAction: 'Cross-sell with jacket purchases.',
  });

  const merged = applyGrowthOpportunityOverrides([rankedDraft, unmatchedDraft], {
    'Insulated Jacket: Send a win-back email.': {
      expectedImpactCategory: 'customer_retention',
      expectedImpactMagnitude: 3,
      actionClassification: 'approval_required',
    },
    // no override supplied for the wool hat draft
  });

  const result = rankAvailableGrowthOpportunities(merged);
  assert.strictEqual(result.total_candidates, 2);
  assert.strictEqual(result.ranked.length, 1);
  assert.strictEqual(result.ranked[0].opportunity, 'Insulated Jacket: Send a win-back email.');
  assert.strictEqual(result.unranked.length, 1);
  assert.strictEqual(result.unranked[0].candidate.opportunity, 'Wool Hat: Cross-sell with jacket purchases.');
  assert.deepStrictEqual(result.unranked[0].missing_fields, [
    'expectedImpactCategory',
    'expectedImpactMagnitude',
    'actionClassification',
  ]);
  assert.ok(result.limitations[0].includes('1 of 2'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
