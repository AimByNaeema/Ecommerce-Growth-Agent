'use strict';

// compliance/etsyIpRiskDetector.js - conservative IP risk indicators.
//
// The two assertions that matter most here are negative ones: the detector can never
// produce a BLOCK, and it never offers a rewrite. Both are what keep "unclear IP goes to
// a human" true in practice.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const detector = require('../../compliance/etsyIpRiskDetector');
const { detectEtsyIpRisk, detectProtectedMarks, detectUnresolvedProperNouns, buildKnownVocabulary, PROTECTED_MARK_INDICATORS } = detector;
const { applyAdditionalFindings, evaluateCompliance } = require('../../compliance/complianceEngine');

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

const OWN_BUSINESS = { brand_names: ['Digital Studio By Naeema'], product_categories: ['Invitation', 'Birthday'] };

function ruleIds(findings) {
  return findings.map((finding) => finding.rule_id);
}

// --- PASS 1: known marks ------------------------------------------------------------

test('a well-known protected mark is detected', () => {
  for (const content of [
    'Mickey Mouse Birthday Invitation',
    'A Bluey themed party invite',
    'Hello Kitty digital design',
    'Winnie The Pooh baby shower',
    'Nike inspired sports invite',
  ]) {
    const findings = detectEtsyIpRisk({ content, businessContext: OWN_BUSINESS });
    assert.ok(ruleIds(findings).includes('etsy_protected_mark_indicator'), `no mark detected in "${content}"`);
  }
});

test('mark detection is case-insensitive', () => {
  assert.strictEqual(detectProtectedMarks('DISNEY princess design').length, 1);
  assert.strictEqual(detectProtectedMarks('disney princess design').length, 1);
});

test('the marks list is explicitly non-exhaustive, and the finding says so', () => {
  const [finding] = detectEtsyIpRisk({ content: 'Disney themed invite', businessContext: OWN_BUSINESS });
  assert.match(finding.reason, /non-exhaustive/);
  assert.match(finding.reason, /not a finding of infringement/i);
});

// --- PASS 2: the structural detector ------------------------------------------------

test('AN UNKNOWN NAME IS FLAGGED - absence from the marks list means nothing', () => {
  // None of these is on any list. Each must still be reported as unresolved, which is
  // what stops the marks list from behaving as a safe-list.
  for (const name of ['Thornfield Manor', 'Aveline Marchetti', 'Quibblesworth']) {
    const findings = detectEtsyIpRisk({ content: `A design featuring ${name} for your day.`, businessContext: OWN_BUSINESS });
    assert.ok(
      ruleIds(findings).includes('etsy_unresolved_proper_noun'),
      `'${name}' must be reported as unresolved, not assumed safe`
    );
  }
});

test("the shop's own declared brand and vocabulary are NOT flagged", () => {
  const findings = detectEtsyIpRisk({
    content: 'Birthday Invitation by Digital Studio By Naeema.',
    businessContext: OWN_BUSINESS,
  });
  const unresolved = findings.filter((finding) => finding.rule_id === 'etsy_unresolved_proper_noun');
  for (const finding of unresolved) {
    assert.ok(!/naeema/i.test(finding.reason), "the shop's own brand must not be reported as unresolved");
  }
});

test('ordinary capitalized language is not mistaken for a name', () => {
  const unresolved = detectUnresolvedProperNouns(
    'Please Note. This Is A Digital Download. Thank You for your order. Instant Download.',
    buildKnownVocabulary(OWN_BUSINESS)
  );
  assert.strictEqual(unresolved.length, 0, `sentence-case words must not be reported: ${JSON.stringify(unresolved)}`);
});

test('declaring a name in the vocabulary stops it being reported', () => {
  // Both an Etsy-style title and a prose sentence, because the name sits in a different
  // position in each and the escape hatch has to work for both.
  for (const content of ['Thornfield Manor Wedding Invitation', 'Featuring Thornfield Manor.']) {
    const before = detectUnresolvedProperNouns(content, buildKnownVocabulary(OWN_BUSINESS));
    assert.strictEqual(before.length, 1, `expected one unresolved name in "${content}"`);
    assert.strictEqual(before[0].phrase, 'Thornfield Manor', 'the reported phrase must be the name a human would declare');

    const after = detectUnresolvedProperNouns(
      content,
      buildKnownVocabulary({ ...OWN_BUSINESS, known_vocabulary: ['Thornfield Manor'] })
    );
    assert.strictEqual(after.length, 0, `declaring the name must silence it in "${content}"`);
  }
});

test('clean content produces no IP findings at all', () => {
  const findings = detectEtsyIpRisk({
    content: 'a hand drawn floral border for a celebration, in soft muted tones',
    businessContext: OWN_BUSINESS,
  });
  assert.strictEqual(findings.length, 0);
});

// --- THE HARD LIMITS ----------------------------------------------------------------

test('NO FINDING IS EVER BLOCK - unclear IP is REVIEW, never an automatic refusal', () => {
  const findings = detectEtsyIpRisk({
    content: 'Disney Marvel Pokemon Nike Barbie Thornfield Manor Aveline Marchetti',
    businessContext: OWN_BUSINESS,
  });
  assert.ok(findings.length > 0);
  for (const finding of findings) {
    assert.notStrictEqual(finding.severity, 'block', `${finding.rule_id} must never be block`);
    assert.ok(['review', 'info'].includes(finding.severity));
  }
});

test('THE ENGINE REFUSES BLOCK FROM THIS PATH - enforced by construction, not intent', () => {
  const base = evaluateCompliance({
    content: 'A clean design.',
    provenance: { source: 'test', generator: 'test', evidence: ['e'], supported_facts: ['A clean design.'] },
    platform_context: { platform: 'etsy' },
    policy_context: { platform_rules: [{ id: 'r', platform: 'etsy', description: 'd', forbidden_phrases: ['zzz'], severity: 'review' }] },
  });
  assert.throws(
    () => applyAdditionalFindings(base, [{ check_type: 'ip_indicators', rule_id: 'forged', severity: 'block', reason: 'x' }]),
    /refuses a block-severity finding/
  );
});

test('IP findings ESCALATE a verdict and can never relax one', () => {
  const base = evaluateCompliance({
    content: 'Mickey Mouse invitation.',
    provenance: { source: 'test', generator: 'test', evidence: ['e'], supported_facts: ['Mickey Mouse invitation.'] },
    platform_context: { platform: 'etsy' },
    policy_context: { platform_rules: [{ id: 'r', platform: 'etsy', description: 'd', forbidden_phrases: ['zzz'], severity: 'review' }] },
  });
  const escalated = applyAdditionalFindings(base, detectEtsyIpRisk({ content: 'Mickey Mouse invitation.', businessContext: OWN_BUSINESS }));
  assert.strictEqual(escalated.status, 'REVIEW');
  assert.ok(escalated.findings.length > base.findings.length, 'findings are only ever added');
});

test('NO REWRITE IS EVER OFFERED - the detector suggests no replacement wording', () => {
  const findings = detectEtsyIpRisk({ content: 'Mickey Mouse invitation.', businessContext: OWN_BUSINESS });
  for (const finding of findings) {
    assert.ok(!/rewrite|replace .* with|suggested wording|try instead/i.test(finding.recommended_action), finding.rule_id);
  }
  const markFinding = findings.find((finding) => finding.rule_id === 'etsy_protected_mark_indicator');
  assert.match(markFinding.recommended_action, /Do NOT simply delete the name/);
});

test('NO REWRITE OR BRAND-STRIPPING FUNCTION IS EXPORTED', () => {
  for (const name of Object.keys(detector)) {
    assert.ok(
      !/rewrite|sanitiz|sanitis|strip|scrub|remove|replace|cleanse/i.test(name),
      `the detector must not export '${name}' - rewriting around detected IP would hide the risk`
    );
  }
});

test('the marks list is a plain literal list - no phrase is compiled as a regex', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'compliance', 'etsyIpRiskDetector.js'), 'utf8');
  const code = source.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/new RegExp\(/.test(code), 'no term may be compiled into a pattern');
  for (const mark of PROTECTED_MARK_INDICATORS) {
    assert.strictEqual(typeof mark, 'string');
    assert.strictEqual(mark, mark.toLowerCase(), `'${mark}' must be stored lowercase for literal matching`);
  }
});

test('this test file is registered in the suite runner', () => {
  const { TEST_FILES } = require('./runAllTests');
  assert.ok(TEST_FILES.includes('etsyIpRiskDetector.test.js'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
