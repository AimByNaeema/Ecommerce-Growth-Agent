'use strict';

// Tests for compliance/complianceEngine.js - the deterministic Compliance evaluation.
//
// NO MODEL, NO NETWORK, NO EXTERNAL SERVICE IS REACHED BY ANY TEST IN THIS FILE. The
// engine is pure by construction (it imports no client and no integration), which is
// itself asserted below rather than assumed.
//
// Every question, brand, phrase, policy term and draft below is an invented placeholder.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  evaluateCompliance,
  applyAdditionalFindings,
  isEligibleForHumanApproval,
  summarizeComplianceForApproval,
  complianceInputFromContentGenerationResult,
} = require('../../compliance/complianceEngine');
const { createComplianceFinding, validateComplianceResultShape } = require('../../compliance/complianceModel');
const { COPIED_PHRASE_WORD_RUN } = require('../../agent/core/contentBriefEngine');

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

const CLEAN_CONTENT =
  'How long an insulated jacket lasts depends on how often you wear it, how you store it, and how you wash it. With careful storage and gentle washing, a well-made insulated jacket stays warm and usable for a long time. Signs it needs replacing include flattened insulation that no longer lofts, and outer fabric that no longer sheds water.';

const GOOD_PROVENANCE = {
  source: 'seo_content_generation',
  generator: 'tools/seoContentGenerationTool.js',
  evidence: [{ signal_kind: 'competitor_faq', reference: '(placeholder FAQ reference)' }],
};

function check(result, checkType) {
  return result.checks.find((entry) => entry.check_type === checkType);
}

function findingsFor(result, checkType) {
  return result.findings.filter((finding) => finding.check_type === checkType);
}

// --- 1. Valid content with supported evidence -> PASS -----------------------------

test('valid content with supported evidence -> PASS', () => {
  const result = evaluateCompliance({
    content: CLEAN_CONTENT,
    content_type: 'buying guide',
    content_reference: '(placeholder) how-long-does-an-insulated-jacket-last',
    provenance: GOOD_PROVENANCE,
  });
  assert.strictEqual(result.status, 'PASS');
  assert.deepStrictEqual(result.review_reasons, []);
  assert.deepStrictEqual(result.findings, []);
  assert.strictEqual(validateComplianceResultShape(result).valid, true);
  assert.strictEqual(result.content_reference, '(placeholder) how-long-does-an-insulated-jacket-last');
  assert.strictEqual(result.content_type, 'buying guide');
});

test('a PASS still carries the standing limitations and a checked_at timestamp', () => {
  const result = evaluateCompliance({ content: CLEAN_CONTENT, provenance: GOOD_PROVENANCE });
  assert.ok(result.limitations.length >= 3);
  assert.ok(!Number.isNaN(Date.parse(result.checked_at)));
  assert.ok(result.checker_version);
  assert.ok(result.schema_version);
});

// --- 2. Unresolved verification marker -> REVIEW ----------------------------------

test('[VERIFY: ...] / unsupported required verification -> REVIEW', () => {
  const result = evaluateCompliance({
    content: 'An insulated jacket typically lasts [VERIFY: typical lifespan] with normal use and care.',
    provenance: GOOD_PROVENANCE,
  });
  assert.strictEqual(result.status, 'REVIEW');
  assert.ok(result.review_reasons.some((reason) => reason.includes('[VERIFY: typical lifespan]')));
  assert.strictEqual(check(result, 'unsupported_claims').status, 'flagged');
  // The offsets point into our own content so a human can find the passage.
  const finding = findingsFor(result, 'unsupported_claims')[0];
  assert.ok(finding.detected_range && typeof finding.detected_range.start === 'number');
});

test('a figure the caller established is accepted; one they did not is REVIEW', () => {
  const draft = 'Our insulated jackets carry a 3 year warranty against defects, and with care they last well beyond it.';
  const supported = evaluateCompliance({
    content: draft,
    provenance: { ...GOOD_PROVENANCE, supported_facts: ['Our insulated jackets carry a 3 year warranty against defects (placeholder).'] },
  });
  assert.strictEqual(supported.status, 'PASS');

  const unsupported = evaluateCompliance({ content: draft, provenance: GOOD_PROVENANCE });
  assert.strictEqual(unsupported.status, 'REVIEW');
  assert.ok(unsupported.review_reasons.some((reason) => reason.includes('the figure 3 is not in the supplied evidence')));
});

// --- 3. Explicit project-policy violation -> BLOCK --------------------------------

test('a clear explicit project-policy violation -> BLOCK', () => {
  const result = evaluateCompliance({
    content: 'Every design in our store is guaranteed copyright-free, so you can use it however you like.',
    provenance: GOOD_PROVENANCE,
  });
  assert.strictEqual(result.status, 'BLOCK');
  const blocking = result.findings.filter((finding) => finding.severity === 'block');
  assert.strictEqual(blocking.length, 1);
  assert.strictEqual(blocking[0].check_type, 'prohibited_content');
  assert.strictEqual(blocking[0].rule_id, 'legal_guarantee_claim');
  assert.ok(blocking[0].reason.startsWith('Blocked by project policy:'));
});

test('a configured prohibited term -> BLOCK, and it is a rule application, not a judgment', () => {
  const result = evaluateCompliance({
    content: 'This bundle is a placeholder-forbidden-phrase for collectors.',
    provenance: GOOD_PROVENANCE,
    policy_context: { prohibited_terms: ['placeholder-forbidden-phrase'] },
  });
  assert.strictEqual(result.status, 'BLOCK');
  assert.ok(result.review_reasons[0].includes('explicitly prohibits'));
  assert.ok(result.review_reasons[0].includes('not a judgment about the content') === false, 'the reason states the rule');
  assert.strictEqual(result.policy_context.configured_prohibited_terms, 1);
});

test('a configured prohibited term is matched literally, never compiled as a regular expression', () => {
  // A caller/config-supplied policy string must never be able to inject a pattern.
  const result = evaluateCompliance({
    content: 'This listing mentions aaa and nothing else of note.',
    provenance: GOOD_PROVENANCE,
    policy_context: { prohibited_terms: ['a.*a'] },
  });
  assert.strictEqual(result.status, 'PASS', "'a.*a' must be matched as literal text, not as a regex");
});

test('BLOCK CANNOT SILENTLY BECOME PASS: the verdict follows the finding, not the caller', () => {
  const result = evaluateCompliance({
    content: 'Everything here is 100% compliant and there is no legal risk.',
    provenance: GOOD_PROVENANCE,
    // Even asking for the narrowest possible check set cannot suppress a block rule.
    required_checks: [],
  });
  assert.strictEqual(result.status, 'BLOCK');
  assert.ok(result.findings.some((finding) => finding.severity === 'block'));
});

// --- 4. Ambiguous IP / ownership -> REVIEW ----------------------------------------

test('an ambiguous IP/ownership issue -> REVIEW, never a finding of infringement', () => {
  const result = evaluateCompliance({
    content: 'We are an official reseller of (Placeholder Brand) insulated jackets.',
    provenance: GOOD_PROVENANCE,
    business_context: { brand_names: ['(Our Placeholder Store)'], third_party_brands: ['(Placeholder Brand)'] },
  });
  assert.strictEqual(result.status, 'REVIEW');
  const ip = findingsFor(result, 'ip_indicators');
  assert.ok(ip.length >= 2, 'both the affiliation wording and the third-party brand should be detected');
  const joined = JSON.stringify(ip).toLowerCase();
  // Detection, never a legal verdict - not even as a negated mention.
  for (const forbidden of ['infringing', 'infringement', 'unlawful', 'illegal', 'violates copyright', 'violates trademark']) {
    assert.ok(!joined.includes(forbidden), `an IP finding must never use the word '${forbidden}'`);
  }
  assert.ok(joined.includes('detection only'), 'an IP finding must state that it is a detection');
  assert.ok(joined.includes('requires human/legal judgment') || joined.includes('legal/business determination'));
});

test("our own brand name is not reported as a third-party brand", () => {
  const result = evaluateCompliance({
    content: 'At (Our Placeholder Store) we make insulated jackets for wet commutes.',
    provenance: GOOD_PROVENANCE,
    business_context: { brand_names: ['(Our Placeholder Store)'], third_party_brands: ['(Our Placeholder Store)'] },
  });
  assert.strictEqual(result.status, 'PASS');
});

test('a declared third-party brand is matched on whole words, not inside another word', () => {
  const result = evaluateCompliance({
    content: 'Our jackets are windproof and warm.',
    provenance: GOOD_PROVENANCE,
    business_context: { third_party_brands: ['Wind'] },
  });
  assert.strictEqual(result.status, 'PASS', "'Wind' must not be detected inside 'windproof'");
});

// --- 5 & 6. Competitor similarity detection, without reproducing anything ---------

const COMPETITOR_CANARY =
  'ZZQUUX store your insulated jacket loosely in a breathable garment bag away from direct sunlight always';

test('competitor distinctive wording detection works', () => {
  const result = evaluateCompliance({
    content:
      'To protect it, store your insulated jacket loosely in a breathable garment bag away from direct sunlight always, and it will be ready next winter.',
    provenance: GOOD_PROVENANCE,
    reference_materials: [{ id: 'competitor-a', text: COMPETITOR_CANARY, rights_status: 'third_party' }],
  });
  assert.strictEqual(result.status, 'REVIEW');
  const similarity = findingsFor(result, 'reference_similarity');
  assert.strictEqual(similarity.length, 1);
  assert.strictEqual(similarity[0].evidence_reference, 'competitor-a');
  assert.ok(similarity[0].reason.includes(`${COPIED_PHRASE_WORD_RUN} consecutive words`));
  // The affected range in OUR content is reported so a human can find and rewrite it.
  assert.ok(similarity[0].detected_range && similarity[0].detected_range.end > similarity[0].detected_range.start);
});

test('COMPETITOR TEXT IS NEVER REPRODUCED IN THE FINDINGS', () => {
  const result = evaluateCompliance({
    content:
      'To protect it, store your insulated jacket loosely in a breathable garment bag away from direct sunlight always.',
    provenance: GOOD_PROVENANCE,
    reference_materials: [{ id: 'competitor-a', text: COMPETITOR_CANARY, rights_status: 'third_party' }],
  });
  const serialized = JSON.stringify(result);
  // The canary marker only ever existed in the competitor text.
  assert.ok(!serialized.includes('ZZQUUX'), 'competitor text leaked into the compliance result');
  // And the matched passage itself is not carried either - only a fingerprint.
  assert.ok(!serialized.includes('breathable garment bag'), 'the matched passage was reproduced in the result');
  assert.ok(/fingerprint [0-9a-f]{16}/.test(serialized), 'the match should be identified by fingerprint');
});

test('unrelated reference material produces no similarity finding', () => {
  const result = evaluateCompliance({
    content: CLEAN_CONTENT,
    provenance: GOOD_PROVENANCE,
    reference_materials: [{ id: 'competitor-a', text: COMPETITOR_CANARY, rights_status: 'third_party' }],
  });
  assert.strictEqual(check(result, 'reference_similarity').status, 'passed');
  // Third-party material being supplied at all is recorded, but gates nothing.
  const info = findingsFor(result, 'ip_indicators');
  assert.strictEqual(info.length, 1);
  assert.strictEqual(info[0].severity, 'info');
  assert.strictEqual(result.status, 'PASS');
});

// --- 7. Missing provenance -> REVIEW where required -------------------------------

test('missing provenance causes REVIEW where it is required', () => {
  const result = evaluateCompliance({ content: CLEAN_CONTENT });
  assert.strictEqual(result.status, 'REVIEW');
  const provenanceFindings = findingsFor(result, 'provenance');
  assert.strictEqual(provenanceFindings.length, 2, 'both a missing source and missing evidence should be reported');
  assert.ok(result.review_reasons.some((reason) => reason.includes('No provenance source was supplied')));
  assert.ok(result.review_reasons.some((reason) => reason.includes('No supporting evidence was carried')));
});

test('a caller may waive provenance, but the gap is recorded as a limitation rather than hidden', () => {
  const result = evaluateCompliance({ content: CLEAN_CONTENT, require_provenance: false });
  assert.strictEqual(result.status, 'PASS');
  assert.strictEqual(check(result, 'provenance').status, 'not_applicable');
  assert.ok(result.limitations.some((limitation) => limitation.includes('provenance was not required')));
});

test('a REQUIRED check that cannot run becomes a REVIEW finding, never a silent pass', () => {
  const result = evaluateCompliance({
    content: CLEAN_CONTENT,
    provenance: GOOD_PROVENANCE,
    required_checks: ['reference_similarity'],
  });
  assert.strictEqual(result.status, 'REVIEW');
  assert.strictEqual(check(result, 'reference_similarity').status, 'not_completed');
  assert.ok(result.review_reasons.some((reason) => reason.includes('no reference material was supplied')));
});

// --- 8. No fabricated demand/traffic/ranking data ---------------------------------

test('the checker detects fabricated search-volume/traffic/ranking claims', () => {
  const result = evaluateCompliance({
    content: 'This is one of our most-asked questions, with 12,000 monthly searches, and we rank #1 for it.',
    provenance: GOOD_PROVENANCE,
  });
  assert.strictEqual(result.status, 'REVIEW');
  assert.ok(result.review_reasons.some((reason) => reason.includes('Fabricated performance/demand claim')));
});

test('THE CHECKER ITSELF FABRICATES NO METRIC: no result invents a volume, traffic or ranking figure', () => {
  const result = evaluateCompliance({ content: CLEAN_CONTENT, provenance: GOOD_PROVENANCE });
  const serialized = JSON.stringify(result).toLowerCase();
  for (const forbidden of ['search volume', 'monthly searches', 'traffic estimate', 'estimated visits', 'ranks #']) {
    assert.ok(!serialized.includes(forbidden), `the compliance result must not produce '${forbidden}'`);
  }
  // The only numbers it reports are counts of things it actually saw.
  assert.strictEqual(result.provenance.supported_fact_count, 0);
});

// --- 9 & 10. Platform policy: applied, never invented -----------------------------

test('an unknown platform-policy situation -> REVIEW', () => {
  const result = evaluateCompliance({
    content: CLEAN_CONTENT,
    provenance: GOOD_PROVENANCE,
    platform_context: { platform: 'etsy' },
  });
  assert.strictEqual(result.status, 'REVIEW');
  const finding = findingsFor(result, 'platform_policy')[0];
  assert.strictEqual(finding.rule_id, 'platform_policy_undetermined');
  assert.ok(finding.reason.includes('could not be determined'));
  assert.ok(finding.reason.includes('none was invented here'));
});

test('PLATFORM RULES ARE NOT INVENTED: recognizing a platform yields no rule of its own', () => {
  for (const platform of ['shopify', 'etsy', 'amazon', 'ebay']) {
    const result = evaluateCompliance({
      content: CLEAN_CONTENT,
      provenance: GOOD_PROVENANCE,
      platform_context: { platform },
    });
    assert.strictEqual(result.policy_context.structured_platform_rules_applied, 0);
    assert.strictEqual(result.status, 'REVIEW', `${platform} must resolve to REVIEW, never to a guessed rule`);
    // And nothing in the result asserts what that platform actually requires.
    const serialized = JSON.stringify(result).toLowerCase();
    assert.ok(!serialized.includes('prohibits'), 'the result must not assert what a platform prohibits');
  }
});

test('structured caller-supplied platform rules ARE applied, at their declared severity', () => {
  const base = {
    content: 'This listing includes a placeholder-restricted-claim about the product.',
    provenance: GOOD_PROVENANCE,
    platform_context: { platform: 'etsy' },
  };
  const reviewRule = evaluateCompliance({
    ...base,
    policy_context: {
      platform_rules: [
        {
          id: 'placeholder_etsy_rule',
          platform: 'etsy',
          description: '(Placeholder) this phrasing needs review on that platform.',
          forbidden_phrases: ['placeholder-restricted-claim'],
          severity: 'review',
        },
      ],
    },
  });
  assert.strictEqual(reviewRule.status, 'REVIEW');
  assert.strictEqual(reviewRule.policy_context.structured_platform_rules_applied, 1);

  const blockRule = evaluateCompliance({
    ...base,
    policy_context: {
      platform_rules: [
        {
          id: 'placeholder_etsy_block_rule',
          platform: 'etsy',
          description: '(Placeholder) this phrasing is forbidden there.',
          forbidden_phrases: ['placeholder-restricted-claim'],
          severity: 'block',
        },
      ],
    },
  });
  assert.strictEqual(blockRule.status, 'BLOCK');
});

test('a platform rule with a missing/unknown severity defaults to review, never to block', () => {
  const result = evaluateCompliance({
    content: 'This listing includes a placeholder-restricted-claim about the product.',
    provenance: GOOD_PROVENANCE,
    platform_context: { platform: 'etsy' },
    policy_context: {
      platform_rules: [
        { id: 'r', platform: 'etsy', forbidden_phrases: ['placeholder-restricted-claim'], severity: 'catastrophic' },
      ],
    },
  });
  assert.strictEqual(result.status, 'REVIEW');
});

test('no platform context at all is not_applicable, with the gap stated as a limitation', () => {
  const result = evaluateCompliance({ content: CLEAN_CONTENT, provenance: GOOD_PROVENANCE });
  assert.strictEqual(check(result, 'platform_policy').status, 'not_applicable');
  assert.ok(result.limitations.some((limitation) => limitation.includes('No platform context was supplied')));
});

// --- 11 & 12. Compliance neither publishes nor approves ---------------------------

test('COMPLIANCE PUBLISHES NOTHING: the engine imports no integration and no client', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'compliance', 'complianceEngine.js'), 'utf8');
  const requires = [...source.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]);
  for (const dependency of requires) {
    assert.ok(
      !dependency.includes('integrations'),
      `the compliance engine must not import an integration adapter (found ${dependency})`
    );
    assert.ok(
      !/claudeClient|geminiClient|aiProviderSelector|shopifyClient/.test(dependency),
      `the compliance engine must not import a client (found ${dependency})`
    );
  }
  assert.ok(!/\bfetch\s*\(/.test(source), 'the compliance engine must make no network call');
});

test('COMPLIANCE APPROVES NOTHING: the engine never touches the approval workflow', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'compliance', 'complianceEngine.js'), 'utf8');
  assert.ok(!source.includes("require('../approvals/approvalWorkflow')"), 'compliance must not create or decide approvals');
  assert.ok(!source.includes('createApprovalRequest'));
  assert.ok(!source.includes('decideApprovalRequest'));
});

test('a BLOCK is not eligible for human approval, and no override is offered', () => {
  const blocked = evaluateCompliance({
    content: 'Every design here is guaranteed copyright-free.',
    provenance: GOOD_PROVENANCE,
  });
  assert.strictEqual(isEligibleForHumanApproval(blocked), false);

  const review = evaluateCompliance({ content: CLEAN_CONTENT });
  const pass = evaluateCompliance({ content: CLEAN_CONTENT, provenance: GOOD_PROVENANCE });
  assert.strictEqual(isEligibleForHumanApproval(review), true, 'REVIEW may still go to a human - that is the point of REVIEW');
  assert.strictEqual(isEligibleForHumanApproval(pass), true);

  // There is no argument, flag or option that makes a BLOCK eligible.
  assert.strictEqual(isEligibleForHumanApproval({ ...blocked, status: 'BLOCK' }), false);
});

test('the approval summary is plain data an existing approval request can carry', () => {
  const blocked = evaluateCompliance({
    content: 'Every design here is guaranteed copyright-free.',
    provenance: GOOD_PROVENANCE,
  });
  const summary = summarizeComplianceForApproval(blocked);
  assert.strictEqual(summary.compliance_status, 'BLOCK');
  assert.strictEqual(summary.eligible_for_human_approval, false);
  assert.strictEqual(summary.blocking_findings.length, 1);
  assert.ok(summary.review_reasons.length > 0);
  // It is a summary, not a decision: nothing here says who approved anything.
  for (const forbidden of ['decided_by', 'decided_at', 'decision', 'approved']) {
    assert.ok(!(forbidden in summary), `the approval summary must not carry '${forbidden}'`);
  }
});

test('REVIEW PRESERVES ITS REASONS through the approval summary', () => {
  const review = evaluateCompliance({ content: CLEAN_CONTENT });
  const summary = summarizeComplianceForApproval(review);
  assert.deepStrictEqual(summary.review_reasons, review.review_reasons);
  assert.ok(summary.review_reasons.length > 0);
});

// --- Monotonic escalation ---------------------------------------------------------

test('applyAdditionalFindings can escalate PASS -> REVIEW', () => {
  const base = evaluateCompliance({ content: CLEAN_CONTENT, provenance: GOOD_PROVENANCE });
  assert.strictEqual(base.status, 'PASS');
  const escalated = applyAdditionalFindings(base, [
    createComplianceFinding({
      checkType: 'unsupported_claims',
      ruleId: 'placeholder',
      severity: 'review',
      reason: 'A placeholder ambiguity.',
      recommendedAction: 'Have a human check it.',
    }),
  ]);
  assert.strictEqual(escalated.status, 'REVIEW');
  assert.strictEqual(escalated.review_reasons.length, 1);
  // The original is never mutated.
  assert.strictEqual(base.status, 'PASS');
  assert.strictEqual(base.findings.length, 0);
});

test('AN ADDITIONAL FINDING CAN NEVER CLEAR OR DOWNGRADE AN EXISTING ONE', () => {
  const review = evaluateCompliance({ content: CLEAN_CONTENT });
  assert.strictEqual(review.status, 'REVIEW');
  // Adding an info-only finding cannot make it PASS - findings are only ever appended.
  const merged = applyAdditionalFindings(review, [
    createComplianceFinding({
      checkType: 'provenance',
      ruleId: 'placeholder',
      severity: 'info',
      reason: 'Looks fine to me.',
      recommendedAction: 'none',
    }),
  ]);
  assert.strictEqual(merged.status, 'REVIEW');
  assert.ok(merged.review_reasons.length >= review.review_reasons.length);
});

test('A SUPPLEMENTARY CHECK CAN NEVER PRODUCE A BLOCK', () => {
  const base = evaluateCompliance({ content: CLEAN_CONTENT, provenance: GOOD_PROVENANCE });
  assert.throws(
    () =>
      applyAdditionalFindings(base, [
        createComplianceFinding({
          checkType: 'prohibited_content',
          ruleId: 'placeholder',
          severity: 'block',
          reason: 'A judgment call, not a rule.',
          recommendedAction: 'none',
        }),
      ]),
    /may only come from a deterministic project or configured policy rule/
  );
});

// --- Content-generation adapter ---------------------------------------------------

test('the content-generation adapter is a pure projection that preserves provenance', () => {
  const generationResult = {
    opportunity_reference: 'how-long-does-an-insulated-jacket-last',
    generated_content: CLEAN_CONTENT,
    content_type: 'buying guide',
    target_question: 'How long does an insulated jacket last?',
    target_page: '(placeholder) /pages/jacket-care',
    evidence: [{ signal_kind: 'competitor_faq', reference: '(placeholder FAQ reference)' }],
    status: 'ready',
    review_reasons: [],
    limitations: [],
    brief: {},
  };
  const input = complianceInputFromContentGenerationResult(generationResult, {
    supportedFacts: ['(placeholder) established fact'],
    platformContext: { platform: 'website' },
  });
  assert.strictEqual(input.content, CLEAN_CONTENT);
  assert.strictEqual(input.content_type, 'buying guide');
  assert.strictEqual(input.content_reference, 'how-long-does-an-insulated-jacket-last');
  assert.strictEqual(input.provenance.source, 'seo_content_generation');
  assert.deepStrictEqual(input.provenance.evidence, generationResult.evidence);
  // The generation result itself is untouched.
  assert.strictEqual(generationResult.status, 'ready');

  const result = evaluateCompliance(input);
  assert.ok(['PASS', 'REVIEW'].includes(result.status));
});

test('the adapter refuses a result with no generated content rather than checking nothing', () => {
  assert.throws(
    () => complianceInputFromContentGenerationResult({ generated_content: '', opportunity_reference: 'x' }),
    /requires a result carrying generated content/
  );
});

// --- Input handling ---------------------------------------------------------------

test('an unusable input throws rather than returning a fabricated verdict', () => {
  assert.throws(() => evaluateCompliance(undefined));
  assert.throws(() => evaluateCompliance({}));
  assert.throws(() => evaluateCompliance({ content: '   ' }));
});

// --- The legal limitation ---------------------------------------------------------

test('NO LEGAL GUARANTEE IS EVER MADE by any verdict', () => {
  const results = [
    evaluateCompliance({ content: CLEAN_CONTENT, provenance: GOOD_PROVENANCE }),
    evaluateCompliance({ content: CLEAN_CONTENT }),
    evaluateCompliance({ content: 'Every design here is guaranteed copyright-free.', provenance: GOOD_PROVENANCE }),
  ];
  for (const result of results) {
    const serialized = JSON.stringify(result).toLowerCase();
    // Deliberately phrases that could not appear inside a disclaimer or inside quoted
    // detected wording, so a raw scan of the whole result stays meaningful.
    for (const forbidden of [
      'is legally compliant',
      'is legally safe',
      'guaranteed copyright-safe',
      'copyright-free and safe',
      'this content is compliant',
      'no legal risk exists',
      'fully compliant',
    ]) {
      assert.ok(!serialized.includes(forbidden), `a compliance result must never assert '${forbidden}' (status ${result.status})`);
    }
    // And the disclaimer is always present.
    assert.ok(serialized.includes('not legal advice'));
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
