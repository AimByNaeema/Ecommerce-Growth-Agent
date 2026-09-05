'use strict';

// Integration tests for the Compliance -> Human Approval boundary
// (approvals/complianceApprovalGate.js):
//
//   Content -> Compliance -> Human Approval -> approved / rejected
//
// The suite STOPS at approval, exactly as the integration does. Its central claims are
// negative ones, so most tests here try to get something past the gate and assert that
// they cannot: a forged compliance verdict, a forged approval, a BLOCK sneaking in by
// any route, and an approval being mistaken for a publication.
//
// NO MODEL, NETWORK, SHOPIFY, MARKETPLACE, SOCIAL OR CMS CALL IS MADE ANYWHERE IN THIS
// FILE. The gate is deterministic and offline by construction (compliance evaluation
// makes no model call on its default path), which is asserted below rather than assumed.
//
// Every brand, phrase, identity and draft below is an invented placeholder.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  COMPLIANCE_GATED_CLASSIFICATION,
  AUTHORIZATION_LIMITATION,
  requestApprovalForCheckedContent,
  verifyComplianceForApprovalRequest,
  decideComplianceGatedApproval,
  isAuthorizedForPublishing,
} = require('../../approvals/complianceApprovalGate');
const { validateApprovalRequestShape } = require('../../approvals/approvalRequestModel');
const { getClassificationById, requiresApproval } = require('../../approvals/approvalArchitecture');
const { getApprovalRequestById, getPendingApprovalRequests } = require('../../approvals/approvalWorkflow');
const { evaluateCompliance } = require('../../compliance/complianceEngine');
const { createAuditTracker, getEventsByType } = require('../../audit/auditTrail');
const { TOOL_CLASSIFICATIONS, SPECIALIST_ROLE_PERMISSIONS, checkToolAccess } = require('../../agent/core/toolPermissions');
const { MODEL_CALL_TOOL_IDS } = require('../../agent/core/usageLimits');
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

// Content that produces each of the three verdicts, verified as such below rather than
// merely assumed.
const PASSING_CONTENT =
  'How long an insulated jacket lasts depends on how often you wear it, how you store it, and how you wash it. With careful storage and gentle washing it stays warm and usable for a long time.';
const REVIEW_CONTENT = 'An insulated jacket typically lasts [VERIFY: typical lifespan] with normal use and care.';
const BLOCKED_CONTENT = 'Every design in our store is guaranteed copyright-free, so use it however you like.';

function complianceInput(content) {
  return { content, content_reference: '(placeholder) jacket-lifespan', content_type: 'buying guide', provenance: PROVENANCE };
}

function gate(content, overrides = {}) {
  return requestApprovalForCheckedContent({
    id: 'apr-compliance-1',
    toolId: 'compliance_check',
    complianceInput: complianceInput(content),
    ...overrides,
  });
}

test('the fixtures really do produce the three verdicts this suite depends on', () => {
  assert.strictEqual(evaluateCompliance(complianceInput(PASSING_CONTENT)).status, 'PASS');
  assert.strictEqual(evaluateCompliance(complianceInput(REVIEW_CONTENT)).status, 'REVIEW');
  assert.strictEqual(evaluateCompliance(complianceInput(BLOCKED_CONTENT)).status, 'BLOCK');
});

// --- 1. PASS -> eligible for the existing human approval ---------------------------

test('compliance PASS -> a real pending request in the EXISTING approval lifecycle', () => {
  const outcome = gate(PASSING_CONTENT);
  assert.strictEqual(outcome.status, 'pending_approval');
  assert.strictEqual(outcome.compliance_result.status, 'PASS');

  const request = outcome.approval_request;
  // It is an ordinary approvals/approvalRequestModel.js record - no new shape, no new
  // state machine, and it validates against the existing schema unchanged.
  assert.strictEqual(validateApprovalRequestShape(request).valid, true);
  assert.strictEqual(request.status, 'pending');
  assert.strictEqual(request.classification, COMPLIANCE_GATED_CLASSIFICATION);
  assert.ok(getClassificationById(request.classification), 'the classification must be one of the existing four');
  assert.strictEqual(requiresApproval(request.classification), true, 'it must genuinely require approval');
  assert.deepStrictEqual(getPendingApprovalRequests(outcome.requests).map((entry) => entry.id), ['apr-compliance-1']);
});

test('the caller-held array is never mutated - a new array is returned', () => {
  const requests = [];
  const outcome = gate(PASSING_CONTENT, { requests });
  assert.strictEqual(requests.length, 0, 'the array passed in must be left alone');
  assert.strictEqual(outcome.requests.length, 1);
  assert.notStrictEqual(outcome.requests, requests);
});

// --- 2. REVIEW is preserved, and never silently becomes PASS -----------------------

test('compliance REVIEW reaches a human AND carries its reasons onto the request', () => {
  const outcome = gate(REVIEW_CONTENT);
  assert.strictEqual(outcome.status, 'pending_approval');
  assert.strictEqual(outcome.compliance_result.status, 'REVIEW');

  const carried = outcome.approval_request.execution_request.compliance;
  assert.strictEqual(carried.compliance_status, 'REVIEW');
  assert.ok(carried.review_reasons.length > 0, 'a REVIEW must carry its reasons to the approver');
  assert.deepStrictEqual(carried.review_reasons, outcome.compliance_result.review_reasons);
  // And the reason a human reads names the verdict explicitly.
  assert.ok(outcome.approval_request.reason.includes('REVIEW'));
  assert.ok(outcome.approval_request.reason.includes('[VERIFY: typical lifespan]'));
});

test('REVIEW NEVER SILENTLY BECOMES PASS - not even once a human approves it', () => {
  const outcome = gate(REVIEW_CONTENT);
  const decided = decideComplianceGatedApproval(outcome.requests, 'apr-compliance-1', {
    decision: 'approved',
    decidedBy: 'store-owner@example.com (placeholder)',
  });
  assert.strictEqual(decided.ok, true);
  assert.strictEqual(decided.decided_request.status, 'approved');
  // The human decision changed the APPROVAL. It did not change the COMPLIANCE verdict.
  assert.strictEqual(decided.compliance_result.status, 'REVIEW');
  assert.strictEqual(decided.decided_request.execution_request.compliance.compliance_status, 'REVIEW');
  assert.ok(decided.decided_request.execution_request.compliance.review_reasons.length > 0);
});

// --- 3. BLOCK cannot enter approval, and cannot be bypassed ------------------------

test('compliance BLOCK -> NO approval request is created at all', () => {
  const requests = [];
  const outcome = gate(BLOCKED_CONTENT, { requests });
  assert.strictEqual(outcome.status, 'blocked');
  assert.strictEqual(outcome.approval_request, null);
  assert.strictEqual(outcome.requests.length, 0, 'a BLOCK must leave nothing for a human to decide');
  assert.ok(outcome.reason.includes('cannot enter the approval flow'));
});

test('BLOCK CANNOT BE BYPASSED: the gate exposes no override of any kind', () => {
  // Every plausible override name a caller might try. None is a parameter, so none can
  // change the outcome - the BLOCK stands.
  for (const override of [
    { force: true },
    { override: true },
    { allowBlocked: true },
    { bypassCompliance: true },
    { complianceStatus: 'PASS' },
    { compliance_status: 'PASS' },
  ]) {
    const outcome = gate(BLOCKED_CONTENT, override);
    assert.strictEqual(outcome.status, 'blocked', `an override named '${Object.keys(override)[0]}' must not work`);
    assert.strictEqual(outcome.approval_request, null);
  }
});

test('BLOCK cannot be smuggled in by hand-building a pending request around it', () => {
  // The caller fabricates the record the gate refused to create, claiming PASS.
  const forged = gate(PASSING_CONTENT).approval_request;
  forged.execution_request.compliance_input = complianceInput(BLOCKED_CONTENT);

  const verification = verifyComplianceForApprovalRequest(forged);
  assert.strictEqual(verification.ok, false);
  assert.strictEqual(verification.compliance_result.status, 'BLOCK');

  const decided = decideComplianceGatedApproval([forged], forged.id, {
    decision: 'approved',
    decidedBy: 'store-owner@example.com (placeholder)',
  });
  assert.strictEqual(decided.ok, false, 'a BLOCK must not be approvable by any route');
  assert.strictEqual(decided.decided_request, null);
  assert.strictEqual(isAuthorizedForPublishing(forged), false);
});

// --- 4. Human approval is not compliance PASS -------------------------------------

test('HUMAN APPROVAL IS NOT COMPLIANCE PASS: a PASS decides nothing on its own', () => {
  const outcome = gate(PASSING_CONTENT);
  // Compliance said PASS...
  assert.strictEqual(outcome.compliance_result.status, 'PASS');
  // ...and the record is still merely pending, with no decision recorded anywhere.
  assert.strictEqual(outcome.approval_request.status, 'pending');
  assert.strictEqual(outcome.approval_request.decided_by, null);
  assert.strictEqual(outcome.approval_request.decided_at, null);
  assert.strictEqual(isAuthorizedForPublishing(outcome.approval_request), false);
});

test('the two verdicts are stored separately and neither overwrites the other', () => {
  const outcome = gate(PASSING_CONTENT);
  const decided = decideComplianceGatedApproval(outcome.requests, 'apr-compliance-1', {
    decision: 'approved',
    decidedBy: 'store-owner@example.com (placeholder)',
    notes: 'Read it first.',
  });
  const record = decided.decided_request;
  // Human decision on the record itself; compliance verdict inside execution_request.
  assert.strictEqual(record.status, 'approved');
  assert.strictEqual(record.decided_by, 'store-owner@example.com (placeholder)');
  assert.strictEqual(record.execution_request.compliance.compliance_status, 'PASS');
  assert.ok(record.decided_at);
});

// --- 5 & 6. Forgery: the server computes the verdict, never accepts one ------------

test('A CLIENT CANNOT FORGE compliance_status - there is no parameter for one', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'approvals', 'complianceApprovalGate.js'), 'utf8');
  const code = source.replace(/^\s*\/\/.*$/gm, '');
  // The gate takes compliance INPUT and computes the verdict; it never takes a verdict.
  assert.ok(code.includes('evaluateCompliance('), 'the gate must compute the verdict itself');
  assert.ok(!/complianceStatus\s*[,=)]/.test(code), 'no code path may accept a caller-supplied compliance status');
});

test('A FORGED compliance PASS IS REJECTED: the verdict is recomputed from the content', () => {
  const request = gate(REVIEW_CONTENT).approval_request;
  // The client edits the record to claim a clean bill of health.
  request.execution_request.compliance.compliance_status = 'PASS';
  request.execution_request.compliance.review_reasons = [];
  request.execution_request.compliance.eligible_for_human_approval = true;

  const verification = verifyComplianceForApprovalRequest(request);
  assert.strictEqual(verification.ok, false);
  assert.ok(verification.reason.includes("claims compliance status 'PASS'"));
  assert.ok(verification.reason.includes("produces 'REVIEW'"));

  const decided = decideComplianceGatedApproval([request], request.id, {
    decision: 'approved',
    decidedBy: 'store-owner@example.com (placeholder)',
  });
  assert.strictEqual(decided.ok, false);
  assert.strictEqual(decided.decided_request, null);
  // And the record is left exactly as it was - a refused decision changes nothing.
  assert.strictEqual(request.status, 'pending');
});

test('a record that quietly drops its review reasons is refused, even claiming the right status', () => {
  const request = gate(REVIEW_CONTENT).approval_request;
  request.execution_request.compliance.review_reasons = ['(a reason a human never actually saw)'];
  const verification = verifyComplianceForApprovalRequest(request);
  assert.strictEqual(verification.ok, false);
  assert.ok(verification.reason.includes('do not match'));
});

test('a record with no compliance input cannot be verified, so it cannot be decided', () => {
  const request = gate(PASSING_CONTENT).approval_request;
  delete request.execution_request.compliance_input;
  const verification = verifyComplianceForApprovalRequest(request);
  assert.strictEqual(verification.ok, false);
  assert.ok(verification.reason.includes('cannot be re-verified'));
  assert.strictEqual(
    decideComplianceGatedApproval([request], request.id, { decision: 'approved', decidedBy: 'x@example.com' }).ok,
    false
  );
});

test('A FORGED APPROVAL IS REJECTED: an already-approved record cannot be re-decided', () => {
  const outcome = gate(PASSING_CONTENT);
  // The client hands back a record it marked approved itself.
  const forged = {
    ...outcome.approval_request,
    status: 'approved',
    decided_by: 'definitely-a-real-human@example.com (forged)',
    decided_at: new Date().toISOString(),
  };
  const decided = decideComplianceGatedApproval([forged], forged.id, {
    decision: 'approved',
    decidedBy: 'store-owner@example.com (placeholder)',
  });
  assert.strictEqual(decided.ok, false);
  assert.ok(decided.reason.includes("already 'approved', not 'pending'"));
});

test('A DECISION CANNOT BE MADE ANONYMOUSLY: decidedBy is required and recorded', () => {
  const outcome = gate(PASSING_CONTENT);
  for (const decidedBy of [undefined, null, '', '   ']) {
    const decided = decideComplianceGatedApproval(outcome.requests, 'apr-compliance-1', {
      decision: 'approved',
      decidedBy,
    });
    assert.strictEqual(decided.ok, false, `decidedBy '${decidedBy}' must be refused`);
    assert.ok(decided.reason.includes('decidedBy'));
  }
  // The record is untouched by every refused attempt.
  assert.strictEqual(getApprovalRequestById(outcome.requests, 'apr-compliance-1').status, 'pending');
});

test('an invalid decision value is refused by the existing lifecycle, not reinterpreted', () => {
  const outcome = gate(PASSING_CONTENT);
  for (const decision of ['maybe', 'pending', 'published', undefined]) {
    const decided = decideComplianceGatedApproval(outcome.requests, 'apr-compliance-1', {
      decision,
      decidedBy: 'store-owner@example.com (placeholder)',
    });
    assert.strictEqual(decided.ok, false, `decision '${decision}' must be refused`);
  }
});

// --- 7. The existing lifecycle and audit are reused, not replaced -----------------

test('THE EXISTING APPROVAL LIFECYCLE IS REUSED, never reimplemented', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'approvals', 'complianceApprovalGate.js'), 'utf8');
  const code = source.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(code.includes("require('./approvalWorkflow')"));
  assert.ok(code.includes('createApprovalRequest('), 'requests must be created by the existing workflow');
  assert.ok(code.includes('decideApprovalRequest('), 'decisions must go through the existing workflow');
  // No second state machine: the gate never assigns a lifecycle status itself.
  assert.ok(!/status:\s*'approved'/.test(code), 'the gate must never set an approval status itself');
  assert.ok(!/status:\s*'rejected'/.test(code));
  assert.ok(!/decided_by\s*[:=]\s*['"`]/.test(code), 'the gate must never fabricate an approver identity');
});

test('AUDIT IS PRESERVED: pending, decided and refused decisions are all recorded', () => {
  const tracker = createAuditTracker('run-compliance-approval-1');
  const outcome = gate(PASSING_CONTENT, { auditTracker: tracker });
  decideComplianceGatedApproval(outcome.requests, 'apr-compliance-1', {
    decision: 'approved',
    decidedBy: 'store-owner@example.com (placeholder)',
    auditTracker: tracker,
  });
  const events = getEventsByType(tracker, 'approval');
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].status, 'pending');
  assert.strictEqual(events[1].status, 'approved');
  assert.ok(events[1].summary.includes('Nothing was published.'));
});

test('AUDIT records a BLOCK that never became a request, and a refused decision', () => {
  const blockTracker = createAuditTracker('run-compliance-approval-2');
  gate(BLOCKED_CONTENT, { auditTracker: blockTracker });
  assert.strictEqual(getEventsByType(blockTracker, 'approval')[0].status, 'blocked');

  const forgeTracker = createAuditTracker('run-compliance-approval-3');
  const request = gate(REVIEW_CONTENT).approval_request;
  request.execution_request.compliance.compliance_status = 'PASS';
  decideComplianceGatedApproval([request], request.id, {
    decision: 'approved',
    decidedBy: 'x@example.com',
    auditTracker: forgeTracker,
  });
  assert.strictEqual(getEventsByType(forgeTracker, 'approval')[0].status, 'refused');
});

test('AUDIT redaction still applies - the gate opened no secret path', () => {
  const tracker = createAuditTracker('run-compliance-approval-4');
  gate(PASSING_CONTENT, {
    auditTracker: tracker,
    executionRequest: { apiKey: 'sk-ant-CANARY-must-not-appear', objective: 'placeholder' },
  });
  assert.ok(!JSON.stringify(tracker).includes('sk-ant-CANARY-must-not-appear'));
});

// --- 8. Permissions, cost and token controls are untouched ------------------------

test('PERMISSIONS ARE PRESERVED: no role ceiling and no classification changed', () => {
  assert.deepStrictEqual(SPECIALIST_ROLE_PERMISSIONS.research, ['read']);
  assert.deepStrictEqual(SPECIALIST_ROLE_PERMISSIONS.product, ['read']);
  assert.deepStrictEqual(SPECIALIST_ROLE_PERMISSIONS.seo, ['read', 'write']);
  assert.deepStrictEqual(SPECIALIST_ROLE_PERMISSIONS.listing, ['write']);
  assert.deepStrictEqual(SPECIALIST_ROLE_PERMISSIONS.marketing, ['write']);
  assert.deepStrictEqual(SPECIALIST_ROLE_PERMISSIONS.social_advertising, ['read', 'write']);
  assert.deepStrictEqual(SPECIALIST_ROLE_PERMISSIONS.analytics_optimization, ['read']);
  // compliance_check itself is unchanged: still analysis_only, still shared-infra only.
  assert.strictEqual(TOOL_CLASSIFICATIONS.compliance_check, 'analysis_only');
  assert.strictEqual(checkToolAccess({ specialistId: null, toolId: 'compliance_check' }).decision, 'allowed');
  assert.strictEqual(checkToolAccess({ specialistId: 'seo', toolId: 'compliance_check' }).decision, 'denied');
});

test('COST AND TOKEN CONTROLS ARE PRESERVED, and the gate itself spends nothing', () => {
  assert.ok(MODEL_CALL_TOOL_IDS.has('compliance_check'), 'the existing model-call ceiling still covers compliance');
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'approvals', 'complianceApprovalGate.js'), 'utf8');
  // The gate makes no model call at all, so re-verification on every decision is free.
  assert.ok(!source.includes('aiReasoningCompletion'));
  assert.ok(!source.includes('claudeClient'));
  assert.ok(!source.includes('geminiClient'));
  assert.ok(!/\bfetch\s*\(/.test(source));
});

// --- 9, 10 & 11. Approval authorizes future publishing; nothing publishes ---------

test('NOTHING PUBLISHES: no external client or integration is reachable from the gate', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'approvals', 'complianceApprovalGate.js'), 'utf8');
  const requires = [...source.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]);
  for (const dependency of requires) {
    assert.ok(!dependency.includes('integrations'), `the gate must not import ${dependency}`);
  }
  for (const forbidden of ['shopify', 'etsy', 'amazon', 'ebay', 'wordpress', 'publish(']) {
    assert.ok(!source.toLowerCase().includes(forbidden), `the gate must not reference '${forbidden}'`);
  }
});

test('APPROVED IS NOT PUBLISHED: an approval only authorizes a future publishing step', () => {
  const outcome = gate(PASSING_CONTENT);
  const decided = decideComplianceGatedApproval(outcome.requests, 'apr-compliance-1', {
    decision: 'approved',
    decidedBy: 'store-owner@example.com (placeholder)',
  });
  assert.strictEqual(decided.decided_request.status, 'approved');
  // Authorized, and explicitly only that.
  assert.strictEqual(isAuthorizedForPublishing(decided.decided_request), true);
  assert.ok(decided.limitations.includes(AUTHORIZATION_LIMITATION));
  assert.ok(AUTHORIZATION_LIMITATION.includes('no publishing stage'));
  // Nothing in the record says it was published, or where it would go.
  const serialized = JSON.stringify(decided.decided_request);
  for (const forbidden of ['"published"', 'published_at', 'destination', 'live_url']) {
    assert.ok(!serialized.includes(forbidden), `an approved record must not carry '${forbidden}'`);
  }
});

test('REJECTED IS NOT PUBLISHED, and authorizes nothing', () => {
  const outcome = gate(PASSING_CONTENT);
  const decided = decideComplianceGatedApproval(outcome.requests, 'apr-compliance-1', {
    decision: 'rejected',
    decidedBy: 'store-owner@example.com (placeholder)',
    notes: 'Not this one.',
  });
  assert.strictEqual(decided.ok, true);
  assert.strictEqual(decided.decided_request.status, 'rejected');
  assert.strictEqual(isAuthorizedForPublishing(decided.decided_request), false);
});

test('NO PUBLISHING STAGE EXISTS TO BYPASS: no tool in the registry publishes', () => {
  for (const tool of TOOL_REGISTRY) {
    assert.notStrictEqual(tool.operation, 'execute', `${tool.id} would be an externally-executing tool`);
    assert.ok(!/^publish/.test(tool.id), `${tool.id} looks like a publishing tool`);
  }
});

test('isAuthorizedForPublishing requires every condition, every time it is asked', () => {
  const outcome = gate(PASSING_CONTENT);
  const decided = decideComplianceGatedApproval(outcome.requests, 'apr-compliance-1', {
    decision: 'approved',
    decidedBy: 'store-owner@example.com (placeholder)',
  }).decided_request;
  assert.strictEqual(isAuthorizedForPublishing(decided), true);

  // Each condition removed in turn revokes the authorization.
  assert.strictEqual(isAuthorizedForPublishing({ ...decided, status: 'pending' }), false);
  assert.strictEqual(isAuthorizedForPublishing({ ...decided, status: 'rejected' }), false);
  assert.strictEqual(isAuthorizedForPublishing({ ...decided, decided_by: '' }), false);
  assert.strictEqual(isAuthorizedForPublishing({ ...decided, decided_by: null }), false);
  assert.strictEqual(isAuthorizedForPublishing(null), false);
  assert.strictEqual(isAuthorizedForPublishing({}), false);
  // And content that would now BLOCK revokes it even on an approved record.
  const tampered = JSON.parse(JSON.stringify(decided));
  tampered.execution_request.compliance_input = complianceInput(BLOCKED_CONTENT);
  assert.strictEqual(isAuthorizedForPublishing(tampered), false);
});

// --- 12. The integration added no new state ---------------------------------------

test('NO NEW STATE MACHINE, DATABASE OR FRAMEWORK: the gate holds nothing', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'approvals', 'complianceApprovalGate.js'), 'utf8');
  const requires = [...source.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]);
  // Only existing project modules - no package, no driver, no framework.
  for (const dependency of requires) {
    assert.ok(dependency.startsWith('./') || dependency.startsWith('../'), `unexpected dependency: ${dependency}`);
  }
  // Two independent calls cannot see each other's requests: there is no module state.
  const first = gate(PASSING_CONTENT);
  const second = gate(PASSING_CONTENT);
  assert.strictEqual(first.requests.length, 1);
  assert.strictEqual(second.requests.length, 1);
});

test('an unusable compliance input fails honestly and creates no request', () => {
  for (const input of [undefined, {}, { content: '   ' }]) {
    const outcome = requestApprovalForCheckedContent({ id: 'apr-x', toolId: 'compliance_check', complianceInput: input });
    assert.strictEqual(outcome.status, 'failed');
    assert.strictEqual(outcome.approval_request, null);
    assert.strictEqual(outcome.requests.length, 0);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
