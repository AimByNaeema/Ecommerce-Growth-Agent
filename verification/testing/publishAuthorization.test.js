'use strict';

// Security regression tests for the final authorization boundary
// (approvals/publishAuthorization.js):
//
//   Content -> Compliance -> Human Approval -> Publish Authorization -> (nothing yet)
//
// This suite is deliberately adversarial. Most tests here try to obtain authorization
// they should not have - a forged approval, a forged compliance verdict, an approval for
// different content, a decision that never happened - and assert that every one of them
// is refused, and refused for the RIGHT reason.
//
// The structural claim under test is that a client has nothing to forge with:
// authorizePublishing() takes the server-held array plus an id and a content reference,
// and has no parameter for a record, a status, a verdict, or an approver. That is
// asserted directly, not just relied upon.
//
// ZERO REAL EXTERNAL OR API CALLS ARE MADE ANYWHERE IN THIS FILE. The whole boundary is
// deterministic and offline - it imports no client and no adapter, which is itself
// asserted below rather than assumed.
//
// Every brand, phrase, identity and reference below is an invented placeholder.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { AUTHORIZATION_CHECKS, AUTHORIZATION_LIMITATION, authorizePublishing } = require('../../approvals/publishAuthorization');
const {
  requestApprovalForCheckedContent,
  decideComplianceGatedApproval,
} = require('../../approvals/complianceApprovalGate');
const { createApprovalRequest, decideApprovalRequest } = require('../../approvals/approvalWorkflow');
const { createAuditTracker, getEventsByType } = require('../../audit/auditTrail');
const { evaluateCompliance } = require('../../compliance/complianceEngine');
const { SPECIALIST_ROLE_PERMISSIONS, TOOL_CLASSIFICATIONS } = require('../../agent/core/toolPermissions');
const { TOOL_REGISTRY } = require('../../tools/toolRegistry');

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

const PROVENANCE = {
  source: 'seo_content_generation',
  generator: 'tools/seoContentGenerationTool.js',
  evidence: [{ signal_kind: 'competitor_faq', reference: '(placeholder FAQ reference)' }],
};

const CONTENT_REFERENCE = '(placeholder) jacket-lifespan';
const OTHER_CONTENT_REFERENCE = '(placeholder) a-completely-different-page';

const PASSING_CONTENT =
  'How long an insulated jacket lasts depends on how often you wear it, how you store it, and how you wash it.';
const REVIEW_CONTENT = 'An insulated jacket typically lasts [VERIFY: typical lifespan] with normal use and care.';
const BLOCKED_CONTENT = 'Every design in our store is guaranteed copyright-free, so use it however you like.';

function complianceInput(content, contentReference = CONTENT_REFERENCE) {
  return { content, content_reference: contentReference, content_type: 'buying guide', provenance: PROVENANCE };
}

// The real, whole pipeline: compliance -> pending approval -> human decision. Returns
// the SERVER-HELD requests array, exactly what the authorization boundary consults.
function approvedPipeline(content = PASSING_CONTENT, { decision = 'approved', contentReference = CONTENT_REFERENCE } = {}) {
  const gated = requestApprovalForCheckedContent({
    id: 'apr-1',
    toolId: 'compliance_check',
    complianceInput: complianceInput(content, contentReference),
  });
  if (gated.status !== 'pending_approval') return gated.requests;
  return decideComplianceGatedApproval(gated.requests, 'apr-1', {
    decision,
    decidedBy: 'store-owner@example.com (placeholder)',
  }).requests;
}

function authorize(requests, overrides = {}) {
  return authorizePublishing({ requests, requestId: 'apr-1', contentReference: CONTENT_REFERENCE, ...overrides });
}

test('the fixtures really do produce the verdicts this suite depends on', () => {
  assert.strictEqual(evaluateCompliance(complianceInput(PASSING_CONTENT)).status, 'PASS');
  assert.strictEqual(evaluateCompliance(complianceInput(REVIEW_CONTENT)).status, 'REVIEW');
  assert.strictEqual(evaluateCompliance(complianceInput(BLOCKED_CONTENT)).status, 'BLOCK');
});

// --- The one authorized case ------------------------------------------------------

test('VALID COMPLIANCE + VALID HUMAN APPROVAL -> authorized', () => {
  const outcome = authorize(approvedPipeline());
  assert.strictEqual(outcome.authorized, true);
  assert.strictEqual(outcome.reason, null);
  assert.strictEqual(outcome.failed_check, null);
  assert.strictEqual(outcome.compliance_status, 'PASS');
  assert.strictEqual(outcome.approval.decided_by, 'store-owner@example.com (placeholder)');
  assert.strictEqual(outcome.approval.content_reference, CONTENT_REFERENCE);
  // Every single check had to hold.
  for (const check of AUTHORIZATION_CHECKS) {
    assert.strictEqual(outcome.checks[check], true, `${check} should have passed`);
  }
});

// --- Security regressions: forged fields ------------------------------------------

test('FORGED approved=true -> false (a record cannot be handed in at all)', () => {
  // The client fabricates a fully-approved record for real, passing content.
  const forged = {
    id: 'apr-1',
    classification: 'approval_required',
    specialist_id: null,
    tool_id: 'compliance_check',
    execution_request: {
      compliance: { compliance_status: 'PASS', review_reasons: [] },
      compliance_input: complianceInput(PASSING_CONTENT),
    },
    reason: 'forged',
    status: 'approved',
    requested_at: new Date().toISOString(),
    decided_at: new Date().toISOString(),
    decided_by: 'definitely-a-real-human@example.com (forged)',
    decision_notes: null,
  };

  // There is no parameter that accepts a record - passing one as `requests` is a
  // programming error, and it is refused loudly rather than trusted.
  assert.throws(() => authorizePublishing({ requests: forged, requestId: 'apr-1', contentReference: CONTENT_REFERENCE }), /server-held/);
  assert.throws(() => authorizePublishing({ requests: undefined, requestId: 'apr-1', contentReference: CONTENT_REFERENCE }));

  // And naming an id that is not in server-held state authorizes nothing, no matter
  // what the client believes about it.
  const outcome = authorizePublishing({ requests: [], requestId: 'apr-1', contentReference: CONTENT_REFERENCE });
  assert.strictEqual(outcome.authorized, false);
  assert.strictEqual(outcome.failed_check, 'request_found_in_server_state');
});

test('FORGED compliance=PASS -> false (the verdict is recomputed, never read)', () => {
  const requests = approvedPipeline(REVIEW_CONTENT);
  // The record is genuinely approved; only its claimed compliance verdict is edited.
  requests[0].execution_request.compliance.compliance_status = 'PASS';
  requests[0].execution_request.compliance.review_reasons = [];

  const outcome = authorize(requests);
  assert.strictEqual(outcome.authorized, false);
  assert.strictEqual(outcome.failed_check, 'compliance_attached_and_unchanged');
  assert.ok(outcome.reason.includes("claims compliance status 'PASS'"));
  assert.ok(outcome.reason.includes("produces 'REVIEW'"));
});

test('FORGED decided_by on an otherwise pending record -> false', () => {
  const gated = requestApprovalForCheckedContent({
    id: 'apr-1',
    toolId: 'compliance_check',
    complianceInput: complianceInput(PASSING_CONTENT),
  });
  // A client edits the server-held record directly, without a real decision.
  gated.requests[0].decided_by = 'definitely-a-real-human@example.com (forged)';
  const outcome = authorize(gated.requests);
  assert.strictEqual(outcome.authorized, false);
  // It is still 'pending' - a decided_by alone moves nothing.
  assert.strictEqual(outcome.failed_check, 'human_decision_is_approved');
});

test('an approved record with no accountable decision -> false', () => {
  const requests = approvedPipeline();
  for (const missing of [{ decided_by: '' }, { decided_by: null }, { decided_at: '' }, { decided_at: null }]) {
    const tampered = [{ ...requests[0], ...missing }];
    const outcome = authorize(tampered);
    assert.strictEqual(outcome.authorized, false);
    assert.strictEqual(outcome.failed_check, 'decision_is_accountable');
  }
});

test('a record that is not a real approval record -> false', () => {
  const requests = approvedPipeline();
  const notARecord = [{ ...requests[0], classification: 'not_a_real_classification' }];
  const outcome = authorize(notARecord);
  assert.strictEqual(outcome.authorized, false);
  assert.strictEqual(outcome.failed_check, 'record_from_approval_workflow');
});

test('a decision on a classification that never required approval -> false', () => {
  // A genuine, correctly-decided record - but for an auto-approved class, which never
  // needed a human, so it confers no authority over a consequential action.
  const request = createApprovalRequest({
    id: 'apr-1',
    classification: 'analysis_only',
    toolId: 'compliance_check',
    executionRequest: {
      compliance: { compliance_status: 'PASS', review_reasons: [] },
      compliance_input: complianceInput(PASSING_CONTENT),
    },
    reason: 'placeholder',
  });
  const decided = decideApprovalRequest([request], 'apr-1', {
    decision: 'approved',
    decidedBy: 'store-owner@example.com (placeholder)',
  });
  const outcome = authorize(decided);
  assert.strictEqual(outcome.authorized, false);
  assert.strictEqual(outcome.failed_check, 'classification_actually_required_approval');
});

// --- Security regressions: wrong content -------------------------------------------

test('WRONG CONTENT REFERENCE approval -> false', () => {
  const requests = approvedPipeline();
  const outcome = authorize(requests, { contentReference: OTHER_CONTENT_REFERENCE });
  assert.strictEqual(outcome.authorized, false);
  assert.strictEqual(outcome.failed_check, 'approval_matches_content_reference');
  assert.ok(outcome.reason.includes('granted for a different content reference'));
});

test('an approval carrying no content reference authorizes nothing', () => {
  // Built directly so the compliance input genuinely omits content_reference - passing
  // `undefined` through approvedPipeline would just fall back to its default.
  const gated = requestApprovalForCheckedContent({
    id: 'apr-1',
    toolId: 'compliance_check',
    complianceInput: { content: PASSING_CONTENT, content_type: 'buying guide', provenance: PROVENANCE },
  });
  const requests = decideComplianceGatedApproval(gated.requests, 'apr-1', {
    decision: 'approved',
    decidedBy: 'store-owner@example.com (placeholder)',
  }).requests;
  const outcome = authorize(requests);
  assert.strictEqual(outcome.authorized, false);
  assert.strictEqual(outcome.failed_check, 'approval_matches_content_reference');
});

test('a missing or empty content reference in the question authorizes nothing', () => {
  const requests = approvedPipeline();
  for (const contentReference of [undefined, null, '', '   ']) {
    const outcome = authorize(requests, { contentReference });
    assert.strictEqual(outcome.authorized, false);
    assert.strictEqual(outcome.failed_check, 'approval_matches_content_reference');
  }
});

// --- Security regressions: decision states -----------------------------------------

test('PENDING approval -> false', () => {
  const gated = requestApprovalForCheckedContent({
    id: 'apr-1',
    toolId: 'compliance_check',
    complianceInput: complianceInput(PASSING_CONTENT),
  });
  const outcome = authorize(gated.requests);
  assert.strictEqual(outcome.authorized, false);
  assert.strictEqual(outcome.failed_check, 'human_decision_is_approved');
  assert.ok(outcome.reason.includes("is 'pending'"));
});

test('REJECTED approval -> false', () => {
  const outcome = authorize(approvedPipeline(PASSING_CONTENT, { decision: 'rejected' }));
  assert.strictEqual(outcome.authorized, false);
  assert.strictEqual(outcome.failed_check, 'human_decision_is_approved');
  assert.ok(outcome.reason.includes("is 'rejected'"));
});

// --- Security regressions: compliance verdicts -------------------------------------

test('BLOCK compliance -> false, and BLOCK never reaches approval in the first place', () => {
  // The gate refuses to create a request for blocked content at all...
  const gated = requestApprovalForCheckedContent({
    id: 'apr-1',
    toolId: 'compliance_check',
    complianceInput: complianceInput(BLOCKED_CONTENT),
  });
  assert.strictEqual(gated.status, 'blocked');
  assert.strictEqual(authorize(gated.requests).authorized, false);

  // ...and even if an approved record is retro-pointed at blocked content, the
  // recomputed verdict refuses it.
  const requests = approvedPipeline();
  requests[0].execution_request.compliance_input = complianceInput(BLOCKED_CONTENT);
  const outcome = authorize(requests);
  assert.strictEqual(outcome.authorized, false);
  assert.strictEqual(outcome.failed_check, 'compliance_not_block');
});

test('COMPLIANCE PASS ALONE -> false: a verdict is not a decision', () => {
  const gated = requestApprovalForCheckedContent({
    id: 'apr-1',
    toolId: 'compliance_check',
    complianceInput: complianceInput(PASSING_CONTENT),
  });
  assert.strictEqual(gated.compliance_result.status, 'PASS');
  const outcome = authorize(gated.requests);
  assert.strictEqual(outcome.authorized, false);
  assert.strictEqual(outcome.failed_check, 'human_decision_is_approved');
  // The compliance side genuinely passed - it simply is not authorization.
  assert.strictEqual(outcome.checks.request_found_in_server_state, true);
});

test('HUMAN APPROVAL ALONE, without verifiable compliance -> false', () => {
  const requests = approvedPipeline();
  delete requests[0].execution_request.compliance_input;
  const outcome = authorize(requests);
  assert.strictEqual(outcome.authorized, false);
  assert.strictEqual(outcome.failed_check, 'compliance_attached_and_unchanged');
  assert.ok(outcome.reason.includes('cannot be re-verified'));
});

test('COMPLIANCE MUST REMAIN ATTACHED AND UNCHANGED - edited review reasons refuse', () => {
  const requests = approvedPipeline(REVIEW_CONTENT);
  requests[0].execution_request.compliance.review_reasons = ['(a reason a human never actually saw)'];
  const outcome = authorize(requests);
  assert.strictEqual(outcome.authorized, false);
  assert.strictEqual(outcome.failed_check, 'compliance_attached_and_unchanged');
});

// --- REVIEW follows the existing approval architecture ------------------------------

test('REVIEW is authorized ONLY by a real human approval, and stays REVIEW', () => {
  // Unapproved REVIEW: refused for want of a decision, not for the verdict.
  const gated = requestApprovalForCheckedContent({
    id: 'apr-1',
    toolId: 'compliance_check',
    complianceInput: complianceInput(REVIEW_CONTENT),
  });
  assert.strictEqual(gated.compliance_result.status, 'REVIEW');
  assert.strictEqual(authorize(gated.requests).failed_check, 'human_decision_is_approved');

  // Approved REVIEW: authorized through the ordinary approval architecture...
  const outcome = authorize(approvedPipeline(REVIEW_CONTENT));
  assert.strictEqual(outcome.authorized, true);
  // ...and NEVER silently converted to PASS. It is still reported as REVIEW.
  assert.strictEqual(outcome.compliance_status, 'REVIEW');
});

// --- Reuse, and what was NOT built --------------------------------------------------

test('THE EXISTING LIFECYCLE, COMPLIANCE AND PERMISSION CODE ARE REUSED', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'approvals', 'publishAuthorization.js'), 'utf8');
  const code = source.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(code.includes("require('./approvalWorkflow')"));
  assert.ok(code.includes("require('./approvalRequestModel')"));
  assert.ok(code.includes("require('./approvalArchitecture')"));
  assert.ok(code.includes("require('./complianceApprovalGate')"));
  assert.ok(code.includes("require('../agent/core/toolPermissions')"));
  assert.ok(code.includes("require('../audit/auditTrail')"));
  // No new state machine: it decides authorization, it never moves an approval.
  assert.ok(!code.includes('decideApprovalRequest('), 'authorization must not decide approvals');
  assert.ok(!code.includes('createApprovalRequest('), 'authorization must not create approvals');
  assert.ok(!/status:\s*'approved'/.test(code), 'it must never set an approval status');
  assert.ok(!/decided_by\s*[:=]\s*['"`]/.test(code), 'it must never fabricate an approver');
});

test('NO NEW DATABASE, FRAMEWORK, ADAPTER, AI CALL OR DASHBOARD', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'approvals', 'publishAuthorization.js'), 'utf8');
  const requires = [...source.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]);
  for (const dependency of requires) {
    assert.ok(dependency.startsWith('./') || dependency.startsWith('../'), `unexpected dependency: ${dependency}`);
    assert.ok(!dependency.includes('integrations'), `must not import ${dependency}`);
  }
  for (const forbidden of ['aiReasoningCompletion', 'claudeClient', 'geminiClient', 'shopify', 'etsy', 'amazon', 'ebay']) {
    assert.ok(!source.toLowerCase().includes(forbidden.toLowerCase()), `must not reference '${forbidden}'`);
  }
  assert.ok(!/\bfetch\s*\(/.test(source));
  // No hidden state: two independent calls share nothing.
  const requests = approvedPipeline();
  assert.strictEqual(authorize(requests).authorized, true);
  assert.strictEqual(authorizePublishing({ requests: [], requestId: 'apr-1', contentReference: CONTENT_REFERENCE }).authorized, false);
});

test('AUTHORIZATION PUBLISHES NOTHING', () => {
  const outcome = authorize(approvedPipeline());
  assert.strictEqual(outcome.authorized, true);
  assert.ok(outcome.limitations.includes(AUTHORIZATION_LIMITATION));
  assert.ok(AUTHORIZATION_LIMITATION.includes('no publishing stage'));
  // The outcome carries a verdict and a reason - never a destination or a result.
  const serialized = JSON.stringify(outcome);
  for (const forbidden of ['published', 'destination', 'live_url', 'platform_response']) {
    assert.ok(!serialized.includes(forbidden), `an authorization outcome must not carry '${forbidden}'`);
  }
  // And still no tool in the registry can execute externally.
  for (const tool of TOOL_REGISTRY) {
    assert.notStrictEqual(tool.operation, 'execute', `${tool.id} would be an externally-executing tool`);
  }
});

test('PERMISSION IS RE-CHECKED at the moment of asking, not inherited from the approval', () => {
  const requests = approvedPipeline();
  // The same genuinely-approved record, asked about on behalf of a specialist that does
  // not own the tool - approval satisfied the approval gate, never the permission one.
  const outcome = authorize(requests, { specialistId: 'seo' });
  assert.strictEqual(outcome.authorized, false);
  assert.strictEqual(outcome.failed_check, 'tool_permission_still_granted');
  assert.ok(outcome.reason.includes('no longer granted'));

  // Existing permissions are otherwise untouched by this change.
  assert.deepStrictEqual(SPECIALIST_ROLE_PERMISSIONS.seo, ['read', 'write']);
  assert.deepStrictEqual(SPECIALIST_ROLE_PERMISSIONS.research, ['read']);
  assert.strictEqual(TOOL_CLASSIFICATIONS.compliance_check, 'analysis_only');
});

test('AUDIT IS PRESERVED: both grants and refusals are recorded, with redaction intact', () => {
  const tracker = createAuditTracker('run-publish-authorization-1');
  const requests = approvedPipeline();
  authorize(requests, { auditTracker: tracker });
  authorize(requests, { contentReference: OTHER_CONTENT_REFERENCE, auditTracker: tracker });

  const events = getEventsByType(tracker, 'approval');
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].status, 'authorized');
  assert.ok(events[0].summary.includes('Nothing was published.'));
  assert.strictEqual(events[1].status, 'refused');
  assert.ok(events[1].summary.includes('different content reference'));

  const redactionTracker = createAuditTracker('run-publish-authorization-2');
  const tampered = approvedPipeline();
  tampered[0].execution_request.apiKey = 'sk-ant-CANARY-must-not-appear';
  authorize(tampered, { auditTracker: redactionTracker });
  assert.ok(!JSON.stringify(redactionTracker).includes('sk-ant-CANARY-must-not-appear'));
});

test('every refusal names the exact check that failed, and never defaults to allow', () => {
  const outcome = authorize([]);
  assert.strictEqual(outcome.authorized, false);
  assert.ok(AUTHORIZATION_CHECKS.includes(outcome.failed_check));
  // Every check is reported, and every one not yet reached is false - never omitted.
  for (const check of AUTHORIZATION_CHECKS) {
    assert.strictEqual(typeof outcome.checks[check], 'boolean', `${check} must be reported`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
