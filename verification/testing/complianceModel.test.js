'use strict';

// Tests for compliance/complianceModel.js - the compliance input/result contracts and
// the Content/Asset Governance record.
//
// The centre of gravity here is the honesty invariants: these tests construct results
// that a careless caller (or a future edit) might produce and assert the SCHEMA refuses
// them, rather than trusting convention. In particular: a PASS can never hold an
// unresolved finding, a BLOCK can never silently become a PASS, and a REVIEW can never
// lose its reasons.
//
// Pure schema tests - nothing here calls a model, a network, or an external service.

const assert = require('node:assert');
const {
  COMPLIANCE_INPUT_FIELDS,
  COMPLIANCE_RESULT_FIELDS,
  GOVERNANCE_RECORD_FIELDS,
  createEmptyComplianceResult,
  createComplianceFinding,
  createComplianceCheck,
  deriveComplianceStatus,
  deriveReviewReasons,
  validateComplianceInputShape,
  validateComplianceResultShape,
  createGovernanceRecord,
  validateGovernanceRecordShape,
} = require('../../compliance/complianceModel');
const { CHECK_TYPES, LEGAL_LIMITATIONS } = require('../../compliance/compliancePolicy');

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

// A structurally valid result, used as the base every invariant test then breaks in
// exactly one way.
function validResult(overrides = {}) {
  return {
    ...createEmptyComplianceResult('(placeholder) content-1'),
    status: 'PASS',
    checks: CHECK_TYPES.map((checkType) => createComplianceCheck(checkType, 'passed', 'ran')),
    findings: [],
    review_reasons: [],
    limitations: [...LEGAL_LIMITATIONS],
    checked_at: '2026-09-05T00:00:00.000Z',
    ...overrides,
  };
}

function reviewFinding(checkType = 'provenance') {
  return createComplianceFinding({
    checkType,
    ruleId: 'placeholder_rule',
    severity: 'review',
    reason: 'A placeholder review-severity concern.',
    recommendedAction: 'A human should look at it.',
  });
}

function blockFinding(checkType = 'prohibited_content') {
  return createComplianceFinding({
    checkType,
    ruleId: 'placeholder_block_rule',
    severity: 'block',
    reason: 'A placeholder explicit-rule violation.',
    recommendedAction: 'Remove the wording.',
  });
}

// --- Contracts -------------------------------------------------------------------

test('the input contract requires only `content`, so the existing content workflow can call it unchanged', () => {
  const ids = COMPLIANCE_INPUT_FIELDS.map((field) => field.id);
  assert.ok(ids.includes('content'));
  assert.strictEqual(validateComplianceInputShape({ content: 'Some placeholder content.' }).valid, true);
  // Every other documented field is genuinely optional.
  for (const id of ids.filter((field) => field !== 'content')) {
    assert.strictEqual(
      validateComplianceInputShape({ content: 'Some placeholder content.' }).valid,
      true,
      `${id} must not be required`
    );
  }
});

test('the input contract rejects empty content and unknown fields rather than guessing', () => {
  assert.strictEqual(validateComplianceInputShape({ content: '' }).valid, false);
  assert.strictEqual(validateComplianceInputShape({ content: '   ' }).valid, false);
  assert.strictEqual(validateComplianceInputShape('not an object').valid, false);
  const unknown = validateComplianceInputShape({ content: 'x', publish_to: 'shopify' });
  assert.strictEqual(unknown.valid, false);
  assert.ok(unknown.errors.some((error) => error.includes('publish_to')));
});

test('the input contract refuses an unknown required check type instead of ignoring it', () => {
  const result = validateComplianceInputShape({ content: 'x', required_checks: ['not_a_real_check'] });
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('not_a_real_check')));
});

test('the result contract carries everything the task requires', () => {
  const ids = COMPLIANCE_RESULT_FIELDS.map((field) => field.id);
  for (const required of [
    'status',
    'checks',
    'findings',
    'review_reasons',
    'provenance',
    'limitations',
    'checked_at',
  ]) {
    assert.ok(ids.includes(required), `the result contract is missing ${required}`);
  }
});

test('an empty result defaults to REVIEW, never to PASS', () => {
  assert.strictEqual(createEmptyComplianceResult('x').status, 'REVIEW');
});

// --- Findings ---------------------------------------------------------------------

test('a finding must name a real check type, a real severity, a reason and an action', () => {
  assert.throws(() => createComplianceFinding({ checkType: 'nope', severity: 'review', reason: 'r', recommendedAction: 'a' }));
  assert.throws(() => createComplianceFinding({ checkType: 'provenance', severity: 'nope', reason: 'r', recommendedAction: 'a' }));
  assert.throws(() => createComplianceFinding({ checkType: 'provenance', severity: 'review', reason: '', recommendedAction: 'a' }));
  assert.throws(() => createComplianceFinding({ checkType: 'provenance', severity: 'review', reason: 'r', recommendedAction: '' }));
});

test('deriveComplianceStatus is the single rule: block wins, then review, else pass', () => {
  assert.strictEqual(deriveComplianceStatus([]), 'PASS');
  assert.strictEqual(deriveComplianceStatus([reviewFinding()]), 'REVIEW');
  assert.strictEqual(deriveComplianceStatus([blockFinding()]), 'BLOCK');
  // A block finding among review findings still means BLOCK - order cannot soften it.
  assert.strictEqual(deriveComplianceStatus([reviewFinding(), blockFinding(), reviewFinding()]), 'BLOCK');
  // An info finding gates nothing.
  const info = createComplianceFinding({
    checkType: 'ip_indicators',
    severity: 'info',
    reason: 'noted',
    recommendedAction: 'none',
  });
  assert.strictEqual(deriveComplianceStatus([info]), 'PASS');
});

test('deriveReviewReasons puts blocking reasons first so the worst is never buried', () => {
  const reasons = deriveReviewReasons([reviewFinding(), blockFinding()]);
  assert.strictEqual(reasons.length, 2);
  assert.ok(reasons[0].includes('explicit-rule violation'));
});

// --- The honesty invariants -------------------------------------------------------

test('PASS CANNOT CONTAIN AN UNRESOLVED REVIEW FINDING', () => {
  const result = validateComplianceResultShape(
    validResult({ status: 'PASS', findings: [reviewFinding()], review_reasons: [] })
  );
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('cannot be PASS while a block-severity or review-severity finding is present')));
});

test('PASS CANNOT CONTAIN AN UNRESOLVED BLOCKING FINDING', () => {
  const result = validateComplianceResultShape(
    validResult({ status: 'PASS', findings: [blockFinding()], review_reasons: [] })
  );
  assert.strictEqual(result.valid, false);
});

test('BLOCK CANNOT SILENTLY BECOME PASS OR REVIEW', () => {
  // The invariant stated from the other direction: once a block-severity finding
  // exists, no softer status is representable at all.
  for (const status of ['PASS', 'REVIEW']) {
    const result = validateComplianceResultShape(
      validResult({ status, findings: [blockFinding()], review_reasons: ['a placeholder reason'] })
    );
    assert.strictEqual(result.valid, false, `a block finding must not be representable under ${status}`);
    assert.ok(result.errors.some((error) => error.includes('must be BLOCK')));
  }
});

test('a BLOCK must name the rule that produced it - it can never be asserted bare', () => {
  const result = validateComplianceResultShape(
    validResult({ status: 'BLOCK', findings: [], review_reasons: ['blocked, allegedly'] })
  );
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('requires at least one block-severity finding')));
});

test('REVIEW PRESERVES ITS REVIEW REASONS - a reasonless REVIEW is refused', () => {
  const result = validateComplianceResultShape(
    validResult({ status: 'REVIEW', findings: [reviewFinding()], review_reasons: [] })
  );
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('requires at least one review reason')));
});

test('PASS cannot carry review reasons either', () => {
  const result = validateComplianceResultShape(validResult({ status: 'PASS', review_reasons: ['something'] }));
  assert.strictEqual(result.valid, false);
});

test('a check that did not run must be reported, never omitted', () => {
  const result = validateComplianceResultShape(
    validResult({ checks: [createComplianceCheck('provenance', 'passed', 'ran')] })
  );
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('a check that did not run must be reported')));
});

test('the standing legal limitation is never optional', () => {
  const result = validateComplianceResultShape(validResult({ limitations: [] }));
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('limitations must never be empty')));
});

test('a fully valid PASS, REVIEW and BLOCK all validate', () => {
  assert.strictEqual(validateComplianceResultShape(validResult()).valid, true);
  assert.strictEqual(
    validateComplianceResultShape(
      validResult({ status: 'REVIEW', findings: [reviewFinding()], review_reasons: ['A placeholder review-severity concern.'] })
    ).valid,
    true
  );
  assert.strictEqual(
    validateComplianceResultShape(
      validResult({ status: 'BLOCK', findings: [blockFinding()], review_reasons: ['A placeholder explicit-rule violation.'] })
    ).valid,
    true
  );
});

// --- Compliance is not approval ---------------------------------------------------

test('COMPLIANCE DOES NOT APPROVE: no result or governance field records a decision', () => {
  const forbidden = ['approved', 'approved_by', 'decided_by', 'decided_at', 'decision', 'decision_notes', 'approval_status'];
  for (const fields of [COMPLIANCE_RESULT_FIELDS, GOVERNANCE_RECORD_FIELDS, COMPLIANCE_INPUT_FIELDS]) {
    for (const field of fields) {
      assert.ok(!forbidden.includes(field.id), `'${field.id}' would make this look like an approval record`);
    }
  }
});

test('COMPLIANCE DOES NOT PUBLISH: no field is a destination, schedule, or publish flag', () => {
  const forbidden = ['publish', 'published', 'publish_at', 'destination', 'schedule', 'scheduled_at', 'target_url'];
  for (const fields of [COMPLIANCE_RESULT_FIELDS, GOVERNANCE_RECORD_FIELDS, COMPLIANCE_INPUT_FIELDS]) {
    for (const field of fields) {
      assert.ok(!forbidden.includes(field.id), `'${field.id}' would make this a publishing contract`);
    }
  }
});

// --- Governance record ------------------------------------------------------------

test('a governance record retains everything the task requires', () => {
  const record = createGovernanceRecord(
    validResult({
      provenance: {
        source: 'seo_content_generation',
        generator: 'tools/seoContentGenerationTool.js',
        evidence: [{ signal_kind: 'competitor_faq', reference: '(placeholder)' }],
        reference_material_ids: ['ref-1'],
      },
    })
  );
  assert.strictEqual(validateGovernanceRecordShape(record).valid, true);
  assert.strictEqual(record.content_reference, '(placeholder) content-1');
  assert.strictEqual(record.compliance_status, 'PASS');
  assert.strictEqual(record.source_references.source, 'seo_content_generation');
  assert.deepStrictEqual(record.source_references.reference_material_ids, ['ref-1']);
  assert.ok(record.checked_at);
  assert.ok(record.checker_version);
  assert.ok(record.schema_version);
  assert.ok(Array.isArray(record.checks_performed));
});

test('A GOVERNANCE RECORD NEVER STORES THE CONTENT ITSELF', () => {
  const record = createGovernanceRecord(validResult());
  assert.ok(!('content' in record), 'a governance record must not be a second copy of the material');
  assert.strictEqual(validateGovernanceRecordShape({ ...record, content: 'leaked' }).valid, false);
});

test('A GOVERNANCE RECORD NEVER STORES A CREDENTIAL', () => {
  const record = createGovernanceRecord(
    validResult({
      provenance: {
        source: 'seo_content_generation',
        generator: 'g',
        evidence: [{ reference: 'ok', apiKey: 'sk-ant-CANARY-must-not-be-retained' }],
        reference_material_ids: [],
      },
      policy_context: { platform: 'website', shopify_access_token: 'shpat_CANARY-must-not-be-retained' },
    })
  );
  const serialized = JSON.stringify(record);
  assert.ok(!serialized.includes('sk-ant-CANARY-must-not-be-retained'), 'an API key reached the governance record');
  assert.ok(!serialized.includes('shpat_CANARY-must-not-be-retained'), 'an access token reached the governance record');
  assert.ok(serialized.includes('[REDACTED]'), 'the credential-shaped values should have been redacted, not dropped silently');
});

test('createGovernanceRecord refuses to build a record from an invalid result', () => {
  assert.throws(() => createGovernanceRecord(validResult({ status: 'PASS', findings: [blockFinding()] })));
  assert.throws(() => createGovernanceRecord({ not: 'a result' }));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
