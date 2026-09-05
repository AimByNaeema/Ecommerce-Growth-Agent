'use strict';

// The shape of one Compliance evaluation - its input contract, its result contract,
// and the small Content/Asset Governance record derived from a result. Schema and pure
// helpers only, matching every other *Model.js in this project (field list +
// createEmpty* + validate*Shape + CLI printer). All evaluation logic lives in
// compliance/complianceEngine.js; all rule DATA lives in compliance/compliancePolicy.js.
//
// COMPLIANCE IS NOT APPROVAL. This model answers one question - "is this content
// sufficiently safe and compliant to proceed TO human approval?" - and deliberately
// carries no approver, no decision, no decided_by/decided_at, and no status that could
// be mistaken for a sign-off. Whether an authorized human approved something is
// approvals/approvalRequestModel.js's question, and nothing here touches it. There is
// exactly one approval state machine in this codebase and it is not this one.
//
// NOTHING HERE PUBLISHES. No destination, no schedule, no platform credential, no
// publish flag. platform_context records WHERE content is intended to go so the right
// policy check can run - it is never an instruction to send it there.
//
// THE HONESTY INVARIANTS ARE IN THE SCHEMA, NOT IN CONVENTION. validate*Shape below
// mechanically refuses:
//   - a PASS carrying any block/review finding, or any review reason
//   - a BLOCK not carrying at least one block-severity finding (so a BLOCK can never
//     be asserted without the rule that produced it)
//   - a REVIEW carrying no review reason (so REVIEW always says WHY)
//   - a result with no limitations (the standing legal limitation is never optional)
// A caller cannot construct a result that quietly downgrades a block or loses a review
// reason - the shape refuses it.
//
// GOVERNANCE RECORDS HOLD NO CONTENT AND NO CREDENTIALS. createGovernanceRecord()
// deliberately does NOT carry `content`: a governance record is a durable trace of what
// was checked and why, not a second copy of the material. Everything it does carry is
// passed through audit/auditTrail.js's own redactSensitiveData() - reused rather than
// reimplemented (CLAUDE.md rules 3-4), so a credential-shaped value can never land in
// one. This is not a Memory record and does not persist itself; like every other engine
// in this project it is a plain object handed back to its caller.

const { redactSensitiveData } = require('../audit/auditTrail');
const {
  COMPLIANCE_STATUSES,
  CHECK_TYPES,
  CHECK_STATUSES,
  FINDING_SEVERITIES,
  COMPLIANCE_CHECKER_VERSION,
  COMPLIANCE_SCHEMA_VERSION,
} = require('./compliancePolicy');

// ---------------------------------------------------------------------------------
// Input contract.
// ---------------------------------------------------------------------------------
//
// `content` is the only required field. Every other field is optional and absent means
// absent - never inferred, never defaulted to a placeholder - because the existing
// content workflow (agent/core/contentBriefModel.js) cannot supply all of them and
// requiring them would make this capability unusable by the very stage it exists for.
const COMPLIANCE_INPUT_FIELDS = [
  { id: 'content', title: 'Content', type: 'string', description: 'The generated content/asset text to evaluate. The only required field.' },
  { id: 'content_type', title: 'Content type', type: 'string', description: "What kind of content this is - relayed from the producing stage (e.g. agent/core/contentBriefModel.js's content_type), never re-decided here." },
  { id: 'content_reference', title: 'Content reference', type: 'string', description: 'Caller-supplied identifier for the content/asset being checked - never generated internally, matching every other record in this project.' },
  { id: 'provenance', title: 'Provenance', type: 'object', description: 'Where the content came from and what supported it: { source, generator, evidence[], supported_facts[] }. Empty provenance is a reportable REVIEW outcome, never silently treated as fine.' },
  { id: 'reference_materials', title: 'Reference materials', type: 'array', description: 'Third-party/competitor reference text supplied ONLY so copying can be detected against it: [{ id, text, rights_status }]. Never sent to a model, never reproduced in a result.' },
  { id: 'platform_context', title: 'Platform context', type: 'object', description: '{ platform, surface } - where the content is INTENDED to go, so the right policy check runs. Never a destination this system writes to.' },
  { id: 'business_context', title: 'Business context', type: 'object', description: '{ business_id, product_reference, brand_names[], third_party_brands[] } - our own brands (excluded from third-party detection) and the third-party brands the caller knows are in play.' },
  { id: 'policy_context', title: 'Policy context', type: 'object', description: '{ prohibited_terms[], platform_rules[] } - caller/configuration-supplied explicit rules the checker APPLIES. No platform policy is asserted by this project.' },
  { id: 'required_checks', title: 'Required checks', type: 'array', description: "Which CHECK_TYPES must actually run. A required check that cannot run becomes a REVIEW finding - it never silently passes. Defaults to compliancePolicy.js's DEFAULT_REQUIRED_CHECKS." },
  { id: 'require_provenance', title: 'Require provenance', type: 'boolean', description: 'Whether missing provenance is a REVIEW finding (default true). Setting it false records an explicit limitation rather than hiding the gap.' },
];

// ---------------------------------------------------------------------------------
// Result contract.
// ---------------------------------------------------------------------------------

const COMPLIANCE_FINDING_FIELDS = [
  { id: 'check_type', title: 'Check type', type: `enum: ${CHECK_TYPES.join(' | ')}`, description: 'Which check produced this finding.' },
  { id: 'rule_id', title: 'Rule id', type: 'string', description: 'The specific policy rule or detector that fired - so a finding can always be traced back to the rule, never to a bare opinion.' },
  { id: 'severity', title: 'Severity', type: `enum: ${FINDING_SEVERITIES.join(' | ')}`, description: "'block' (an explicit rule was violated), 'review' (human/legal/policy judgment is required), 'info' (recorded, gates nothing)." },
  { id: 'reason', title: 'Reason', type: 'string', description: 'Plain-language statement of what was detected. Never asserts legal status, infringement, or clearance.' },
  { id: 'evidence_reference', title: 'Evidence reference', type: 'string | null', description: 'Which supplied reference material or evidence entry this relates to, by id - never the material itself.' },
  { id: 'detected_range', title: 'Detected range', type: 'object | null', description: '{ start, end } character offsets into the checked content, where a specific passage is implicated. Offsets only - no third-party text is ever carried here.' },
  { id: 'recommended_action', title: 'Recommended action', type: 'string', description: 'What a human should do about it. Advice only - nothing acts on it.' },
];

const COMPLIANCE_CHECK_FIELDS = [
  { id: 'check_type', title: 'Check type', type: `enum: ${CHECK_TYPES.join(' | ')}`, description: 'Which check this entry reports on. Every check type always appears, including ones that did not run.' },
  { id: 'status', title: 'Status', type: `enum: ${CHECK_STATUSES.join(' | ')}`, description: "'passed' (ran, found nothing), 'flagged' (ran, produced findings), 'not_applicable' (no input made it relevant), 'not_completed' (it was required but could not run - always accompanied by a REVIEW finding)." },
  { id: 'detail', title: 'Detail', type: 'string', description: 'One honest sentence about what this check actually did or why it did not run.' },
];

const COMPLIANCE_RESULT_FIELDS = [
  { id: 'content_reference', title: 'Content reference', type: 'string', description: "The caller's own identifier for the checked content - relayed, never generated." },
  { id: 'content_type', title: 'Content type', type: 'string', description: 'The content type as supplied by the producing stage.' },
  { id: 'status', title: 'Status', type: `enum: ${COMPLIANCE_STATUSES.join(' | ')}`, description: 'PASS (no issue detected by current checks), REVIEW (human/legal/policy judgment required), BLOCK (an explicit project or caller-declared rule was violated).' },
  { id: 'checks', title: 'Checks', type: 'array', description: 'One COMPLIANCE_CHECK_FIELDS entry per CHECK_TYPES member - what ran, what did not, and why.' },
  { id: 'findings', title: 'Findings', type: 'array', description: 'Every COMPLIANCE_FINDING_FIELDS entry produced. Empty only when nothing was detected.' },
  { id: 'review_reasons', title: 'Review reasons', type: 'array', description: 'One entry per reason this is not a PASS, preserved verbatim for the human decision. Empty only when status is PASS.' },
  { id: 'provenance', title: 'Provenance', type: 'object', description: 'The provenance actually used, carried forward so a reader can see where the content came from and what supported it.' },
  { id: 'policy_context', title: 'Policy context', type: 'object', description: 'The platform/policy context the checks ran under, including which structured rules were available.' },
  { id: 'limitations', title: 'Limitations', type: 'array', description: "Honest caveats - always populated, always including compliancePolicy.js's standing legal limitations. Never omitted." },
  { id: 'checked_at', title: 'Checked at', type: 'string', description: 'When this evaluation ran (ISO timestamp).' },
  { id: 'checker_version', title: 'Checker version', type: 'string', description: 'The rule-set version that produced this result.' },
  { id: 'schema_version', title: 'Schema version', type: 'string', description: 'The version of this result contract.' },
];

// The governance record: what is worth RETAINING about a compliance evaluation. A
// projection of the result, minus the content itself.
const GOVERNANCE_RECORD_FIELDS = [
  { id: 'content_reference', title: 'Content reference', type: 'string', description: 'Which content/asset this record is about.' },
  { id: 'content_type', title: 'Content type', type: 'string', description: 'What kind of content it was.' },
  { id: 'source_references', title: 'Source references', type: 'object', description: 'Provenance references only - source, generator, evidence and reference-material ids. Never the source text.' },
  { id: 'compliance_status', title: 'Compliance status', type: `enum: ${COMPLIANCE_STATUSES.join(' | ')}`, description: 'The verdict that was reached.' },
  { id: 'checks_performed', title: 'Checks performed', type: 'array', description: 'Which checks ran, and which did not.' },
  { id: 'findings', title: 'Findings', type: 'array', description: 'The findings, exactly as reported.' },
  { id: 'review_reasons', title: 'Review reasons', type: 'array', description: 'Why a human decision is needed - preserved so the reason survives the record.' },
  { id: 'policy_context', title: 'Policy context', type: 'object', description: 'The policy/platform context the evaluation ran under.' },
  { id: 'checked_at', title: 'Checked at', type: 'string', description: 'When the evaluation ran.' },
  { id: 'checker_version', title: 'Checker version', type: 'string', description: 'Which rule set produced it.' },
  { id: 'schema_version', title: 'Schema version', type: 'string', description: 'Which result contract it conforms to.' },
];

const RESULT_ARRAY_FIELDS = COMPLIANCE_RESULT_FIELDS.filter((f) => f.type === 'array').map((f) => f.id);
const RESULT_OBJECT_FIELDS = COMPLIANCE_RESULT_FIELDS.filter((f) => f.type === 'object').map((f) => f.id);
const GOVERNANCE_ARRAY_FIELDS = GOVERNANCE_RECORD_FIELDS.filter((f) => f.type === 'array').map((f) => f.id);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------------
// Constructors.
// ---------------------------------------------------------------------------------

function createEmptyComplianceResult(contentReference = '') {
  return {
    content_reference: contentReference,
    content_type: '',
    // The cautious default: a result that is never populated must not read as cleared.
    status: 'REVIEW',
    checks: [],
    findings: [],
    review_reasons: [],
    provenance: {},
    policy_context: {},
    limitations: [],
    checked_at: '',
    checker_version: COMPLIANCE_CHECKER_VERSION,
    schema_version: COMPLIANCE_SCHEMA_VERSION,
  };
}

function createComplianceFinding({
  checkType,
  ruleId,
  severity,
  reason,
  evidenceReference = null,
  detectedRange = null,
  recommendedAction,
} = {}) {
  if (!CHECK_TYPES.includes(checkType)) {
    throw new Error(`createComplianceFinding requires \`checkType\` to be one of: ${CHECK_TYPES.join(', ')}, got '${checkType}'.`);
  }
  if (!FINDING_SEVERITIES.includes(severity)) {
    throw new Error(`createComplianceFinding requires \`severity\` to be one of: ${FINDING_SEVERITIES.join(', ')}, got '${severity}'.`);
  }
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new Error('createComplianceFinding requires a non-empty `reason` - a finding must always say what was detected.');
  }
  if (typeof recommendedAction !== 'string' || recommendedAction.trim() === '') {
    throw new Error('createComplianceFinding requires a non-empty `recommendedAction`.');
  }
  return {
    check_type: checkType,
    rule_id: typeof ruleId === 'string' ? ruleId : '',
    severity,
    reason: reason.trim(),
    evidence_reference: typeof evidenceReference === 'string' ? evidenceReference : null,
    detected_range: isPlainObject(detectedRange) ? detectedRange : null,
    recommended_action: recommendedAction.trim(),
  };
}

function createComplianceCheck(checkType, status, detail) {
  if (!CHECK_TYPES.includes(checkType)) {
    throw new Error(`createComplianceCheck requires \`checkType\` to be one of: ${CHECK_TYPES.join(', ')}, got '${checkType}'.`);
  }
  if (!CHECK_STATUSES.includes(status)) {
    throw new Error(`createComplianceCheck requires \`status\` to be one of: ${CHECK_STATUSES.join(', ')}, got '${status}'.`);
  }
  return { check_type: checkType, status, detail: typeof detail === 'string' ? detail : '' };
}

// ---------------------------------------------------------------------------------
// Status derivation - the single place a verdict is decided from findings.
// ---------------------------------------------------------------------------------
//
// Exported and reused by compliance/complianceEngine.js so there is exactly one rule
// for how findings become a verdict: any block-severity finding means BLOCK, any
// review-severity finding means REVIEW, and only a complete absence of both is PASS.
// There is no argument, flag, or override that can make findings produce a softer
// verdict than this.
function deriveComplianceStatus(findings) {
  const list = Array.isArray(findings) ? findings : [];
  if (list.some((finding) => finding && finding.severity === 'block')) return 'BLOCK';
  if (list.some((finding) => finding && finding.severity === 'review')) return 'REVIEW';
  return 'PASS';
}

// Every reason a human needs, in finding order. Block reasons come first so the most
// consequential one is never buried.
function deriveReviewReasons(findings) {
  const list = Array.isArray(findings) ? findings : [];
  const blocking = list.filter((finding) => finding && finding.severity === 'block').map((finding) => finding.reason);
  const review = list.filter((finding) => finding && finding.severity === 'review').map((finding) => finding.reason);
  return [...blocking, ...review];
}

// ---------------------------------------------------------------------------------
// Validation - where the honesty invariants actually live.
// ---------------------------------------------------------------------------------

function validateComplianceInputShape(input) {
  const errors = [];
  if (!isPlainObject(input)) {
    return { valid: false, errors: ['compliance input must be a plain object'] };
  }
  const expectedIds = COMPLIANCE_INPUT_FIELDS.map((field) => field.id);
  for (const id of Object.keys(input)) {
    if (!expectedIds.includes(id)) errors.push(`unexpected field: ${id}`);
  }
  if (typeof input.content !== 'string' || input.content.trim() === '') {
    errors.push('content must be a non-empty string - there is nothing to check otherwise');
  }
  for (const id of ['reference_materials', 'required_checks']) {
    if (id in input && input[id] !== undefined && input[id] !== null && !Array.isArray(input[id])) {
      errors.push(`${id} must be an array`);
    }
  }
  for (const id of ['provenance', 'platform_context', 'business_context', 'policy_context']) {
    if (id in input && input[id] !== undefined && input[id] !== null && !isPlainObject(input[id])) {
      errors.push(`${id} must be an object`);
    }
  }
  if (Array.isArray(input.required_checks)) {
    for (const checkType of input.required_checks) {
      if (!CHECK_TYPES.includes(checkType)) {
        errors.push(`required_checks contains an unknown check type '${checkType}' - it must be one of: ${CHECK_TYPES.join(', ')}`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

function validateFindingShape(finding, index) {
  const errors = [];
  if (!isPlainObject(finding)) return [`findings[${index}] must be a plain object`];
  const expectedIds = COMPLIANCE_FINDING_FIELDS.map((field) => field.id);
  for (const id of expectedIds) {
    if (!(id in finding)) errors.push(`findings[${index}] missing field: ${id}`);
  }
  for (const id of Object.keys(finding)) {
    if (!expectedIds.includes(id)) errors.push(`findings[${index}] unexpected field: ${id}`);
  }
  if ('check_type' in finding && !CHECK_TYPES.includes(finding.check_type)) {
    errors.push(`findings[${index}].check_type must be one of: ${CHECK_TYPES.join(', ')}`);
  }
  if ('severity' in finding && !FINDING_SEVERITIES.includes(finding.severity)) {
    errors.push(`findings[${index}].severity must be one of: ${FINDING_SEVERITIES.join(', ')}`);
  }
  if ('reason' in finding && (typeof finding.reason !== 'string' || finding.reason.trim() === '')) {
    errors.push(`findings[${index}].reason must be a non-empty string`);
  }
  return errors;
}

function validateComplianceResultShape(record) {
  const errors = [];
  if (!isPlainObject(record)) {
    return { valid: false, errors: ['compliance result must be a plain object'] };
  }

  const expectedIds = COMPLIANCE_RESULT_FIELDS.map((field) => field.id);
  const actualIds = Object.keys(record);
  for (const id of expectedIds) {
    if (!actualIds.includes(id)) errors.push(`missing field: ${id}`);
  }
  for (const id of actualIds) {
    if (!expectedIds.includes(id)) errors.push(`unexpected field: ${id}`);
  }
  for (const id of RESULT_ARRAY_FIELDS) {
    if (id in record && !Array.isArray(record[id])) errors.push(`${id} must be an array`);
  }
  for (const id of RESULT_OBJECT_FIELDS) {
    if (id in record && !isPlainObject(record[id])) errors.push(`${id} must be an object`);
  }
  if ('status' in record && !COMPLIANCE_STATUSES.includes(record.status)) {
    errors.push(`status must be one of: ${COMPLIANCE_STATUSES.join(', ')}`);
  }

  if (Array.isArray(record.findings)) {
    record.findings.forEach((finding, index) => errors.push(...validateFindingShape(finding, index)));
  }

  if (Array.isArray(record.checks)) {
    const seen = new Set();
    for (const check of record.checks) {
      if (!isPlainObject(check) || !CHECK_TYPES.includes(check.check_type)) {
        errors.push('every checks entry must name a real check type');
        continue;
      }
      if (!CHECK_STATUSES.includes(check.status)) {
        errors.push(`checks entry '${check.check_type}' has an unknown status '${check.status}'`);
      }
      seen.add(check.check_type);
    }
    for (const checkType of CHECK_TYPES) {
      if (!seen.has(checkType)) {
        errors.push(`checks is missing an entry for '${checkType}' - a check that did not run must be reported, never omitted`);
      }
    }
  }

  // --- The honesty invariants -----------------------------------------------------
  if (Array.isArray(record.findings) && COMPLIANCE_STATUSES.includes(record.status)) {
    const hasBlocking = record.findings.some((finding) => finding && finding.severity === 'block');
    const hasReview = record.findings.some((finding) => finding && finding.severity === 'review');

    // A PASS cannot carry an unresolved blocking or review finding.
    if (record.status === 'PASS' && (hasBlocking || hasReview)) {
      errors.push('status cannot be PASS while a block-severity or review-severity finding is present');
    }
    // A BLOCK must name the rule that produced it - it can never be asserted bare.
    if (record.status === 'BLOCK' && !hasBlocking) {
      errors.push('status BLOCK requires at least one block-severity finding naming the rule that was violated');
    }
    // A block-severity finding can never coexist with a softer verdict: BLOCK cannot
    // silently become PASS or REVIEW.
    if (hasBlocking && record.status !== 'BLOCK') {
      errors.push(`a block-severity finding is present, so status must be BLOCK, not '${record.status}'`);
    }
    if (record.status === 'REVIEW' && !hasReview && !hasBlocking) {
      errors.push('status REVIEW requires at least one review-severity finding');
    }
  }

  if (Array.isArray(record.review_reasons) && COMPLIANCE_STATUSES.includes(record.status)) {
    if (record.status === 'PASS' && record.review_reasons.length > 0) {
      errors.push('status cannot be PASS while review_reasons is non-empty');
    }
    if (record.status !== 'PASS' && record.review_reasons.length === 0) {
      errors.push(`status '${record.status}' requires at least one review reason - a verdict must always say why`);
    }
  }

  // The standing legal limitation is never optional.
  if (Array.isArray(record.limitations) && record.limitations.length === 0) {
    errors.push('limitations must never be empty - the standing legal limitation is attached to every result');
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------------
// Content/Asset Governance record.
// ---------------------------------------------------------------------------------

// Derives the retainable governance record from a finished result. Deliberately drops
// `content` (a governance record is a trace, not a second copy of the material) and
// passes everything it does keep through audit/auditTrail.js's redactSensitiveData(),
// so a credential-shaped value in a caller's provenance or policy context can never be
// retained here. Pure - persists nothing, and duplicates no Memory responsibility.
function createGovernanceRecord(result) {
  const validation = validateComplianceResultShape(result);
  if (!validation.valid) {
    throw new Error(`createGovernanceRecord requires a valid compliance result: ${validation.errors.join('; ')}`);
  }

  const provenance = isPlainObject(result.provenance) ? result.provenance : {};
  return redactSensitiveData({
    content_reference: result.content_reference,
    content_type: result.content_type,
    source_references: {
      source: provenance.source || null,
      generator: provenance.generator || null,
      evidence: Array.isArray(provenance.evidence) ? provenance.evidence : [],
      reference_material_ids: Array.isArray(provenance.reference_material_ids) ? provenance.reference_material_ids : [],
    },
    compliance_status: result.status,
    checks_performed: result.checks,
    findings: result.findings,
    review_reasons: result.review_reasons,
    policy_context: result.policy_context,
    checked_at: result.checked_at,
    checker_version: result.checker_version,
    schema_version: result.schema_version,
  });
}

function validateGovernanceRecordShape(record) {
  const errors = [];
  if (!isPlainObject(record)) {
    return { valid: false, errors: ['governance record must be a plain object'] };
  }
  const expectedIds = GOVERNANCE_RECORD_FIELDS.map((field) => field.id);
  const actualIds = Object.keys(record);
  for (const id of expectedIds) {
    if (!actualIds.includes(id)) errors.push(`missing field: ${id}`);
  }
  for (const id of actualIds) {
    if (!expectedIds.includes(id)) errors.push(`unexpected field: ${id}`);
  }
  for (const id of GOVERNANCE_ARRAY_FIELDS) {
    if (id in record && !Array.isArray(record[id])) errors.push(`${id} must be an array`);
  }
  if ('compliance_status' in record && !COMPLIANCE_STATUSES.includes(record.compliance_status)) {
    errors.push(`compliance_status must be one of: ${COMPLIANCE_STATUSES.join(', ')}`);
  }
  // A governance record must never become a place content is stored.
  if ('content' in record) errors.push('a governance record must not carry the content itself');
  return { valid: errors.length === 0, errors };
}

module.exports = {
  COMPLIANCE_INPUT_FIELDS,
  COMPLIANCE_RESULT_FIELDS,
  COMPLIANCE_FINDING_FIELDS,
  COMPLIANCE_CHECK_FIELDS,
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
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - compliance model (schema only):\n');
  console.log('Input fields:');
  COMPLIANCE_INPUT_FIELDS.forEach((field, index) => console.log(`  ${index + 1}. [${field.id}] ${field.title} (${field.type})`));
  console.log('\nResult fields:');
  COMPLIANCE_RESULT_FIELDS.forEach((field, index) => console.log(`  ${index + 1}. [${field.id}] ${field.title} (${field.type})`));
  console.log('\nGovernance record fields:');
  GOVERNANCE_RECORD_FIELDS.forEach((field, index) => console.log(`  ${index + 1}. [${field.id}] ${field.title} (${field.type})`));
  console.log('\nExample empty result:');
  console.log(JSON.stringify(createEmptyComplianceResult('(no content reference set)'), null, 2));
  console.log('\nCompliance is not approval: no field above records who approved anything.');
}
