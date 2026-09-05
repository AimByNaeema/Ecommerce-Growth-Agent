'use strict';

// Tests for compliance/compliancePolicy.js - the project's explicit compliance rule
// DATA. The point of most of these tests is what the policy deliberately does NOT
// contain: no invented platform rule, and no vocabulary that would read as a legal
// guarantee.
//
// Pure data assertions - nothing here calls a model, a network, or an external service.

const assert = require('node:assert');
const {
  COMPLIANCE_STATUSES,
  CHECK_TYPES,
  FINDING_SEVERITIES,
  DEFAULT_REQUIRED_CHECKS,
  PROHIBITED_ASSERTION_RULES,
  AFFILIATION_CLAIM_RULES,
  RECOGNIZED_PLATFORMS,
  LEGAL_LIMITATIONS,
  COMPLIANCE_CHECKER_VERSION,
  fingerprintPhrase,
  getPlatformRulesFor,
} = require('../../compliance/compliancePolicy');

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

test('the three outcomes are exactly PASS, REVIEW and BLOCK', () => {
  assert.deepStrictEqual(COMPLIANCE_STATUSES, ['PASS', 'REVIEW', 'BLOCK']);
});

test('the checks and severities are a closed set', () => {
  assert.deepStrictEqual(CHECK_TYPES, [
    'provenance',
    'unsupported_claims',
    'reference_similarity',
    'ip_indicators',
    'platform_policy',
    'prohibited_content',
  ]);
  assert.deepStrictEqual(FINDING_SEVERITIES, ['block', 'review', 'info']);
});

test('only content-only checks are required by default, so a missing INPUT is not mistaken for a concern', () => {
  assert.deepStrictEqual(DEFAULT_REQUIRED_CHECKS, ['provenance', 'unsupported_claims', 'prohibited_content']);
  for (const checkType of DEFAULT_REQUIRED_CHECKS) {
    assert.ok(CHECK_TYPES.includes(checkType));
  }
});

test('NO PLATFORM RULE IS INVENTED: recognized platforms carry names only, never policy', () => {
  // The whole point: this project has never established what Shopify/Etsy/Amazon/eBay
  // actually require, so it must assert nothing. RECOGNIZED_PLATFORMS is a list of bare
  // strings - if it ever becomes a list of rule objects, that is a fabricated policy
  // database and this test must fail.
  assert.ok(Array.isArray(RECOGNIZED_PLATFORMS));
  for (const platform of RECOGNIZED_PLATFORMS) {
    assert.strictEqual(typeof platform, 'string', 'a recognized platform must be a bare name, never a rule object');
  }
  // And no rule set is retrievable for any of them from the policy module itself.
  for (const platform of RECOGNIZED_PLATFORMS) {
    assert.deepStrictEqual(getPlatformRulesFor([], platform), []);
    assert.deepStrictEqual(getPlatformRulesFor(undefined, platform), []);
  }
});

test("getPlatformRulesFor never falls back to another platform's rules", () => {
  const rules = [{ id: 'r1', platform: 'etsy', forbidden_phrases: ['x'], severity: 'review' }];
  assert.strictEqual(getPlatformRulesFor(rules, 'etsy').length, 1);
  assert.strictEqual(getPlatformRulesFor(rules, 'amazon').length, 0);
  // Case/whitespace tolerant, but never cross-platform.
  assert.strictEqual(getPlatformRulesFor(rules, ' ETSY ').length, 1);
});

test('both project rule sets are deterministic patterns with a stated action', () => {
  assert.ok(PROHIBITED_ASSERTION_RULES.length > 0);
  assert.ok(AFFILIATION_CLAIM_RULES.length > 0);
  for (const rule of [...PROHIBITED_ASSERTION_RULES, ...AFFILIATION_CLAIM_RULES]) {
    assert.ok(rule.pattern instanceof RegExp, `${rule.id} must be a deterministic pattern`);
    assert.ok(typeof rule.description === 'string' && rule.description.length > 0);
    assert.ok(typeof rule.recommended_action === 'string' && rule.recommended_action.length > 0);
  }
});

test('the legal-guarantee rule fires on the exact wording this system must never emit', () => {
  const rule = PROHIBITED_ASSERTION_RULES.find((entry) => entry.id === 'legal_guarantee_claim');
  for (const phrase of [
    'every design is guaranteed copyright-free',
    'this artwork is guaranteed trademark safe',
    'our listings are 100% compliant',
    'the wording is legally safe',
    'there is no legal risk in using this',
    'fully legal for commercial use',
  ]) {
    assert.ok(rule.pattern.test(phrase), `expected the legal-guarantee rule to fire on: ${phrase}`);
  }
});

test('the legal-guarantee rule does not fire on ordinary product prose', () => {
  const rule = PROHIBITED_ASSERTION_RULES.find((entry) => entry.id === 'legal_guarantee_claim');
  for (const phrase of [
    'This jacket is fully lined and warm in wet weather.',
    'Our returns policy is simple and free.',
    'A guaranteed fit, or send it back.',
  ]) {
    assert.ok(!rule.pattern.test(phrase), `the legal-guarantee rule should not fire on: ${phrase}`);
  }
});

test('NO LEGAL GUARANTEE IS EVER STATED: the standing limitations disclaim, never assure', () => {
  assert.ok(LEGAL_LIMITATIONS.length >= 3);
  const joined = LEGAL_LIMITATIONS.join(' ').toLowerCase();
  // It must say what it is NOT, and name every clearance it does not give.
  assert.ok(joined.includes('not legal advice'));
  assert.ok(joined.includes('not a clearance'));
  assert.ok(joined.includes('establishes legal compliance, copyright clearance, trademark clearance, or the absence of legal risk'));
  // And it must never phrase anything as an assurance. These are deliberately phrases
  // that could not appear inside a disclaimer, so a raw scan stays meaningful.
  for (const forbidden of ['guaranteed copyright-safe', '100% compliant', 'there is no legal risk', 'fully compliant']) {
    assert.ok(!joined.includes(forbidden), `the standing limitations must never assert: ${forbidden}`);
  }
});

test('the standing limitations state plainly that Compliance neither approves nor publishes', () => {
  const joined = LEGAL_LIMITATIONS.join(' ').toLowerCase();
  assert.ok(joined.includes('neither approves nor publishes'));
  assert.ok(joined.includes('still requires explicit human approval'));
});

test('a checker version exists so a stored governance record names its rule set', () => {
  assert.ok(/^compliance-checker\/\d+\.\d+\.\d+$/.test(COMPLIANCE_CHECKER_VERSION));
});

test('fingerprintPhrase is stable, short, and does not reproduce the phrase', () => {
  const phrase = 'store your insulated jacket loosely in a breathable garment bag';
  const fingerprint = fingerprintPhrase(phrase);
  assert.strictEqual(fingerprint, fingerprintPhrase(phrase), 'must be stable');
  assert.strictEqual(fingerprint.length, 16);
  assert.ok(!fingerprint.includes('jacket'), 'a fingerprint must not contain the phrase');
  assert.notStrictEqual(fingerprint, fingerprintPhrase(`${phrase} away from sunlight`));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
