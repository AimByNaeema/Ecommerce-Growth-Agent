'use strict';

// compliance/etsyPolicyRules.js - the Etsy rule data, and how the existing engine
// consumes it. Pure and offline: no network, no mocking needed.

const assert = require('node:assert');
const {
  ETSY_PLATFORM_RULES,
  DIGITAL_PRODUCT_FULFILMENT_RULES,
  ETSY_BASE_RULES,
  getEtsyPlatformRules,
  getEtsyRuleById,
} = require('../../compliance/etsyPolicyRules');
const { PLATFORM_RULE_SEVERITIES, RECOGNIZED_PLATFORMS } = require('../../compliance/compliancePolicy');
const { evaluateCompliance } = require('../../compliance/complianceEngine');

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

// One compliance input, so each test varies only the content and the rules.
function checkWith(content, rules) {
  return evaluateCompliance({
    content,
    content_type: 'etsy_listing',
    content_reference: 'test_listing',
    provenance: { source: 'etsy_listing_data_retrieval', generator: 'test', evidence: ['listing'], supported_facts: [content] },
    platform_context: { platform: 'etsy', surface: 'listing' },
    policy_context: { platform_rules: rules },
    required_checks: ['platform_policy'],
  });
}

test('every rule matches the shape checkPlatformPolicy consumes', () => {
  for (const rule of ETSY_PLATFORM_RULES) {
    assert.ok(typeof rule.id === 'string' && rule.id.trim() !== '', 'a rule needs an id');
    assert.strictEqual(rule.platform, 'etsy');
    assert.ok(typeof rule.description === 'string' && rule.description.trim() !== '');
    assert.ok(Array.isArray(rule.forbidden_phrases) && rule.forbidden_phrases.length > 0);
    for (const phrase of rule.forbidden_phrases) {
      assert.ok(typeof phrase === 'string' && phrase.trim() !== '', `${rule.id} has an empty phrase`);
    }
    assert.ok(PLATFORM_RULE_SEVERITIES.includes(rule.severity), `${rule.id} has severity '${rule.severity}'`);
  }
});

test('rule ids are unique, and getEtsyRuleById finds them', () => {
  const ids = ETSY_PLATFORM_RULES.map((rule) => rule.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.ok(getEtsyRuleById(ids[0]));
  assert.strictEqual(getEtsyRuleById('no_such_rule'), null);
});

test("'etsy' is a platform the existing policy module already recognizes", () => {
  assert.ok(RECOGNIZED_PLATFORMS.includes('etsy'));
});

test('BLOCK: a confirmed-digital product described as shipped is blocked', () => {
  const rules = getEtsyPlatformRules({ isDigitalProduct: true });
  const result = checkWith('Lovely design. Your order ships in 3 business days.', rules);
  assert.strictEqual(result.status, 'BLOCK');
  assert.ok(result.findings.some((f) => f.rule_id === 'etsy_digital_product_physical_shipping_claim' && f.severity === 'block'));
});

test('BLOCK: a confirmed-digital product described as printed on cardstock is blocked', () => {
  const rules = getEtsyPlatformRules({ isDigitalProduct: true });
  const result = checkWith('Each invitation is printed on cardstock and looks beautiful.', rules);
  assert.strictEqual(result.status, 'BLOCK');
  assert.ok(result.findings.some((f) => f.rule_id === 'etsy_digital_product_physical_material_claim'));
});

test('THE DIGITAL RULES DO NOT APPLY ON AN ASSUMPTION when product nature is unknown', () => {
  const rules = getEtsyPlatformRules({ isDigitalProduct: null });
  assert.strictEqual(rules.length, ETSY_BASE_RULES.length, 'unknown nature must not pull in the fulfilment rules');
  const result = checkWith('Your order ships in 3 business days.', rules);
  assert.notStrictEqual(result.status, 'BLOCK', 'blocking on an unverified assumption would be fabrication');
});

test('a genuinely physical product is not blocked for shipping - the rules are not applied', () => {
  const rules = getEtsyPlatformRules({ isDigitalProduct: false });
  const result = checkWith('Your order ships in 3 business days.', rules);
  assert.notStrictEqual(result.status, 'BLOCK');
});

test('REVIEW: ambiguous fulfilment wording reviews rather than blocks', () => {
  const rules = getEtsyPlatformRules({ isDigitalProduct: true });
  const result = checkWith('There is no shipping cost because nothing is posted to you.', rules);
  assert.strictEqual(result.status, 'REVIEW');
  assert.ok(result.findings.some((f) => f.rule_id === 'etsy_digital_product_fulfilment_wording_needs_review'));
  assert.ok(!result.findings.some((f) => f.severity === 'block'));
});

test('REVIEW: unevidenced file, licence and platform-compatibility claims all review', () => {
  const rules = getEtsyPlatformRules({ isDigitalProduct: true });
  for (const [content, ruleId] of [
    ['Fully editable in Canva.', 'etsy_third_party_editing_platform_claim'],
    ['Includes commercial use rights.', 'etsy_licensing_or_commercial_use_claim'],
    ['High resolution 300 dpi files.', 'etsy_file_specification_claim'],
  ]) {
    const result = checkWith(content, rules);
    assert.strictEqual(result.status, 'REVIEW', `"${content}" should review`);
    assert.ok(result.findings.some((f) => f.rule_id === ruleId), `expected ${ruleId} for "${content}"`);
  }
});

test('PASS is reachable - the rules are not a blanket refusal', () => {
  const rules = getEtsyPlatformRules({ isDigitalProduct: true });
  const result = checkWith('A hand-drawn floral border design for a celebration.', rules);
  assert.strictEqual(result.status, 'PASS');
});

test('AMBIGUITY RESOLVES TO REVIEW, NEVER PASS: no rules supplied means undetermined', () => {
  const result = checkWith('A hand-drawn floral border design.', []);
  assert.strictEqual(result.status, 'REVIEW');
  assert.ok(result.findings.some((f) => f.rule_id === 'platform_policy_undetermined'));
});

test('NO DUPLICATION: guarantee and affiliation wording is left to the existing rules', () => {
  // compliancePolicy.js's PROHIBITED_ASSERTION_RULES / AFFILIATION_CLAIM_RULES already
  // cover these, so repeating them here would double-report one problem.
  const phrases = ETSY_PLATFORM_RULES.flatMap((rule) => rule.forbidden_phrases);
  for (const overlap of ['guarantee', 'guaranteed', 'official partner', 'endorsed by', '100% compliant']) {
    assert.ok(!phrases.includes(overlap), `'${overlap}' is already covered by the project-wide rules`);
  }
});

test('every rule set is isolated in this one file, so a policy change is a one-file edit', () => {
  assert.strictEqual(
    ETSY_PLATFORM_RULES.length,
    DIGITAL_PRODUCT_FULFILMENT_RULES.length + ETSY_BASE_RULES.length,
    'every rule must belong to exactly one declared set'
  );
});

// --- NEGATION: THE STANDARD DIGITAL DISCLAIMER IS NOT A VIOLATION -------------------
//
// These came from running the checker against the owner's REAL Etsy listings, where the
// block-severity fulfilment rule fired on 12 of 25 listings - every one of them on a correct
// "no physical item is shipped" disclaimer.

const { checkEtsyListingCompliance } = require('../../compliance/etsyComplianceInput');

function verdictFor(description) {
  return checkEtsyListingCompliance({
    listing_id: 1,
    channel: 'etsy',
    title: 'Invitation Template',
    description,
    tags: ['invitation'],
    listing_type: 'download',
    is_digital_product: true,
  }).result;
}

test('NEGATED: the standard "no physical item will be shipped" disclaimer does NOT block', () => {
  // Verbatim from the real listing that exposed this.
  const verdict = verdictFor('This is a digital product only. No physical invitation will be shipped.');
  const blocking = verdict.findings.filter((f) => f.severity === 'block');
  assert.deepStrictEqual(blocking, [], 'a denial of shipping must never be read as a shipping claim');
  assert.notStrictEqual(verdict.status, 'BLOCK');
});

test('NEGATED: the suppression is still reported as a limitation, never silently dropped', () => {
  const verdict = verdictFor('This is a digital product only. No physical invitation will be shipped.');
  assert.ok(
    verdict.limitations.some((l) => l.includes('negates')),
    'a human must be able to see that the checker saw the wording and judged it a denial'
  );
});

test('NOT NEGATED: a real shipping claim on a digital product STILL blocks', () => {
  const verdict = verdictFor('Your order ships in 3 business days.');
  assert.ok(verdict.findings.some((f) => f.severity === 'block'), 'the rule must still catch the real violation');
  assert.strictEqual(verdict.status, 'BLOCK');
});

test('SCOPE IS ONE CLAUSE: a negation elsewhere cannot excuse a real violation', () => {
  // A different sentence must not launder the claim...
  const separateSentence = verdictFor('No refunds are offered. Your order ships in 3 business days.');
  assert.ok(separateSentence.findings.some((f) => f.severity === 'block'), 'a negation in a PRIOR sentence must not suppress');

  // ...and neither may a negator that appears AFTER the matched phrase.
  const negatorAfter = verdictFor('Your order ships in 3 business days, no exceptions.');
  assert.ok(negatorAfter.findings.some((f) => f.severity === 'block'), 'a negation AFTER the phrase must not suppress');
});

test('this test file is registered in the suite runner', () => {
  const { TEST_FILES } = require('./runAllTests');
  assert.ok(TEST_FILES.includes('etsyPolicyRules.test.js'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
