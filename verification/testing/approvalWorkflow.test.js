'use strict';

const assert = require('node:assert');
// Real Ed25519 approval signatures - see approvalSigningTestKey.js. Verification itself is
// never mocked: every decision below is signed for real and checked by the real gate.
const { signedDecision } = require('./approvalSigningTestKey');
const {
  createApprovalRequest,
  decideApprovalRequest,
  getApprovalRequestById,
  getPendingApprovalRequests,
  isApprovalGranted,
} = require('../../approvals/approvalWorkflow');

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

function baseArgs(overrides = {}) {
  return {
    id: 'apr-1',
    classification: 'externally_executable',
    specialistId: 'seo',
    toolId: 'hypothetical_publish_listing',
    executionRequest: { objective: 'publish updated title', tool_id: 'hypothetical_publish_listing' },
    reason: 'Explicit approval required.',
    ...overrides,
  };
}

// --- createApprovalRequest -----------------------------------------------------------

test('createApprovalRequest produces a valid, pending record', () => {
  const request = createApprovalRequest(baseArgs());
  assert.strictEqual(request.id, 'apr-1');
  assert.strictEqual(request.classification, 'externally_executable');
  assert.strictEqual(request.specialist_id, 'seo');
  assert.strictEqual(request.tool_id, 'hypothetical_publish_listing');
  assert.deepStrictEqual(request.execution_request, baseArgs().executionRequest);
  assert.strictEqual(request.status, 'pending');
  assert.ok(request.requested_at.length > 0);
  assert.strictEqual(request.decided_at, null);
  assert.strictEqual(request.decided_by, null);
  assert.strictEqual(request.decision_notes, null);
});

test('createApprovalRequest defaults specialistId to null for shared infrastructure', () => {
  const request = createApprovalRequest(baseArgs({ specialistId: null }));
  assert.strictEqual(request.specialist_id, null);
});

test('createApprovalRequest throws for a missing id', () => {
  assert.throws(() => createApprovalRequest(baseArgs({ id: '' })), /non-empty `id`/);
});

test('createApprovalRequest throws for a missing toolId', () => {
  assert.throws(() => createApprovalRequest(baseArgs({ toolId: '' })), /non-empty `toolId`/);
});

test('createApprovalRequest throws for a missing reason', () => {
  assert.throws(() => createApprovalRequest(baseArgs({ reason: '' })), /non-empty `reason`/);
});

test('createApprovalRequest throws for an invalid classification', () => {
  assert.throws(() => createApprovalRequest(baseArgs({ classification: 'not_real' })), /real classification ids/);
});

test('createApprovalRequest throws for a missing executionRequest', () => {
  assert.throws(() => createApprovalRequest(baseArgs({ executionRequest: null })), /executionRequest.*object/);
});

test('createApprovalRequest throws for a non-string, non-null specialistId', () => {
  assert.throws(() => createApprovalRequest(baseArgs({ specialistId: 42 })), /specialistId.*string or null/);
});

// --- decideApprovalRequest -------------------------------------------------------------

test('decideApprovalRequest approves a pending request, setting decided_by/decided_at, without mutating the input array', () => {
  const request = createApprovalRequest(baseArgs());
  const original = [request];
  const originalSnapshot = JSON.parse(JSON.stringify(original));

  const updated = decideApprovalRequest(original, 'apr-1', signedDecision(original, 'apr-1', {
    decision: 'approved',
    decidedBy: 'owner@example.com',
    notes: 'Reviewed manually.',
  }));

  assert.deepStrictEqual(original, originalSnapshot, 'input array must never be mutated');
  assert.strictEqual(updated[0].status, 'approved');
  assert.strictEqual(updated[0].decided_by, 'owner@example.com');
  assert.strictEqual(updated[0].decision_notes, 'Reviewed manually.');
  assert.ok(updated[0].decided_at.length > 0);
});

test('decideApprovalRequest rejects a pending request', () => {
  const request = createApprovalRequest(baseArgs());
  const updated = decideApprovalRequest([request], 'apr-1', signedDecision([request], 'apr-1', { decision: 'rejected', decidedBy: 'owner@example.com' }));
  assert.strictEqual(updated[0].status, 'rejected');
});

test('decideApprovalRequest throws for an unknown request id', () => {
  const request = createApprovalRequest(baseArgs());
  assert.throws(
    () => decideApprovalRequest([request], 'apr-does-not-exist', signedDecision([request], 'apr-does-not-exist', { decision: 'approved', decidedBy: 'owner@example.com' })),
    /found no request/
  );
});

test('decideApprovalRequest throws when re-deciding an already-decided request', () => {
  const request = createApprovalRequest(baseArgs());
  const decidedOnce = decideApprovalRequest([request], 'apr-1', signedDecision([request], 'apr-1', { decision: 'approved', decidedBy: 'owner@example.com' }));
  assert.throws(
    () => decideApprovalRequest(decidedOnce, 'apr-1', signedDecision(decidedOnce, 'apr-1', { decision: 'rejected', decidedBy: 'someone-else@example.com' })),
    /already 'approved', not 'pending'/
  );
});

test('decideApprovalRequest throws for an invalid decision value', () => {
  const request = createApprovalRequest(baseArgs());
  assert.throws(
    () => decideApprovalRequest([request], 'apr-1', signedDecision([request], 'apr-1', { decision: 'maybe', decidedBy: 'owner@example.com' })),
    /decision.*to be one of/
  );
});

test('decideApprovalRequest throws for a missing decidedBy', () => {
  const request = createApprovalRequest(baseArgs());
  assert.throws(
    () => decideApprovalRequest([request], 'apr-1', signedDecision([request], 'apr-1', { decision: 'approved', decidedBy: '' })),
    /non-empty `decidedBy`/
  );
});

test('decideApprovalRequest throws for a non-array requests argument', () => {
  assert.throws(
    () => decideApprovalRequest('not an array', 'apr-1', signedDecision('not an array', 'apr-1', { decision: 'approved', decidedBy: 'owner@example.com' })),
    /requests.*array/
  );
});

// --- read helpers ----------------------------------------------------------------------

test('getApprovalRequestById finds a known record and returns undefined for an unknown one', () => {
  const request = createApprovalRequest(baseArgs());
  assert.strictEqual(getApprovalRequestById([request], 'apr-1').id, 'apr-1');
  assert.strictEqual(getApprovalRequestById([request], 'apr-nope'), undefined);
});

test('getPendingApprovalRequests returns only pending records', () => {
  const pending = createApprovalRequest(baseArgs({ id: 'apr-1' }));
  const decidedRequests = decideApprovalRequest(
    [pending, createApprovalRequest(baseArgs({ id: 'apr-2' }))],
    'apr-1', signedDecision([pending, createApprovalRequest(baseArgs({ id: 'apr-2' }))],
    'apr-1', { decision: 'approved', decidedBy: 'owner@example.com' }));
  const stillPending = getPendingApprovalRequests(decidedRequests);
  assert.strictEqual(stillPending.length, 1);
  assert.strictEqual(stillPending[0].id, 'apr-2');
});

test('isApprovalGranted is true only for an approved record, false for pending/rejected/unknown', () => {
  const pendingReq = createApprovalRequest(baseArgs({ id: 'apr-1' }));
  const rejectedBase = createApprovalRequest(baseArgs({ id: 'apr-2' }));
  const afterRejection = decideApprovalRequest([rejectedBase], 'apr-2', signedDecision([rejectedBase], 'apr-2', { decision: 'rejected', decidedBy: 'owner@example.com' }));
  const afterApproval = decideApprovalRequest([pendingReq], 'apr-1', signedDecision([pendingReq], 'apr-1', { decision: 'approved', decidedBy: 'owner@example.com' }));

  assert.strictEqual(isApprovalGranted(afterApproval, 'apr-1'), true);
  assert.strictEqual(isApprovalGranted(afterRejection, 'apr-2'), false);
  assert.strictEqual(isApprovalGranted([pendingReq], 'apr-1'), false);
  assert.strictEqual(isApprovalGranted([pendingReq], 'apr-does-not-exist'), false);
});

// ===================================================================================
// MANDATORY HUMAN PROVENANCE, end to end through the real lifecycle function.
// ===================================================================================

const { signApproval, signApprovalWithForeignKey } = require('./approvalSigningTestKey');
const { validateApprovalRequestShape } = require('../../approvals/approvalRequestModel');

function freshPending(id = 'apr-prov-flow') {
  return createApprovalRequest({
    id,
    classification: 'externally_executable',
    specialistId: 'product',
    toolId: 'shopify_vendor_correction',
    executionRequest: { objective: 'correct the vendor', tool_id: 'shopify_vendor_correction' },
    reason: 'Executing this tool requires explicit approval before it can proceed.',
  });
}

test('AN AGENT CANNOT APPROVE ITS OWN ACTION through decideApprovalRequest', () => {
  const request = freshPending();
  // Exactly what in-process code could produce on its own: a name, and any number of
  // plausible-looking claims. Every one must be refused.
  for (const options of [
    { decision: 'approved', decidedBy: 'store-owner@example.com' },
    { decision: 'approved', decidedBy: 'store-owner@example.com', authorization: null },
    { decision: 'approved', decidedBy: 'store-owner@example.com', authorization: {} },
    { decision: 'approved', decidedBy: 'store-owner@example.com', authorization: { human: true } },
    { decision: 'approved', decidedBy: 'store-owner@example.com', authorization: { nonce: 'x', signature: 'y' } },
  ]) {
    assert.throws(
      () => decideApprovalRequest([request], request.id, options),
      /not accompanied by verified human authorization/,
      `${JSON.stringify(options.authorization)} must not approve anything`
    );
  }
  // And the record is untouched - a refused decision changes nothing.
  assert.strictEqual(request.status, 'pending');
  assert.strictEqual(request.decided_by, null);
});

test('A FORGED SIGNATURE (wrong key) cannot approve, even with a real challenge', () => {
  const request = freshPending('apr-prov-forged');
  assert.throws(
    () =>
      decideApprovalRequest([request], request.id, {
        decision: 'approved',
        decidedBy: 'test-approver@example.com',
        authorization: signApprovalWithForeignKey({ request, decision: 'approved', decidedBy: 'test-approver@example.com' }),
      }),
    /signature_verifies_under_public_key/
  );
  assert.strictEqual(request.status, 'pending');
});

test('A REAL signature approves, and the verified provenance is stored on the record', () => {
  const request = freshPending('apr-prov-ok');
  const updated = decideApprovalRequest([request], request.id, {
    decision: 'approved',
    decidedBy: 'test-approver@example.com',
    authorization: signApproval({ request, decision: 'approved', decidedBy: 'test-approver@example.com' }),
  });
  const decided = updated[0];

  assert.strictEqual(decided.status, 'approved');
  assert.strictEqual(decided.decided_by, 'test-approver@example.com');

  const provenance = decided.execution_request.approval_provenance;
  assert.ok(provenance, 'the verified provenance must be recorded on the approved record');
  assert.strictEqual(provenance.method, 'ed25519_signature');
  assert.strictEqual(provenance.request_id, request.id);
  assert.strictEqual(provenance.decision, 'approved');
  assert.strictEqual(provenance.decided_by, 'test-approver@example.com');
  assert.ok(typeof provenance.execution_fingerprint === 'string' && provenance.execution_fingerprint.length === 64);
  assert.ok(typeof provenance.verified_at === 'string' && provenance.verified_at !== '');

  // The original execution request survives intact beside it - provenance is added, never
  // substituted for what was approved.
  assert.strictEqual(decided.execution_request.objective, 'correct the vendor');
  assert.strictEqual(decided.execution_request.tool_id, 'shopify_vendor_correction');

  // The record still satisfies the schema - provenance rides inside execution_request
  // precisely so the approval record's own shape is unchanged.
  assert.strictEqual(validateApprovalRequestShape(decided).valid, true);
});

test('A SIGNATURE CANNOT BE REUSED for a second decision', () => {
  const first = freshPending('apr-prov-replay-1');
  const authorization = signApproval({ request: first, decision: 'approved', decidedBy: 'test-approver@example.com' });
  decideApprovalRequest([first], first.id, { decision: 'approved', decidedBy: 'test-approver@example.com', authorization });

  const second = freshPending('apr-prov-replay-1');
  assert.throws(
    () => decideApprovalRequest([second], second.id, { decision: 'approved', decidedBy: 'test-approver@example.com', authorization }),
    /challenge_not_already_used/
  );
  assert.strictEqual(second.status, 'pending');
});

test('THE CALLER CANNOT FORGE A RECORD: a hand-built "approved" record is not schema-valid provenance', () => {
  // A caller can of course construct an object - but it cannot construct a VERIFIED one,
  // and decideApprovalRequest is still the only function that can move a real request out
  // of pending. A record fabricated as already-approved is refused by this function outright.
  const forged = { ...freshPending('apr-prov-hand'), status: 'approved', decided_by: 'me', decided_at: new Date().toISOString() };
  assert.throws(
    () => decideApprovalRequest([forged], forged.id, {
      decision: 'rejected',
      decidedBy: 'test-approver@example.com',
      authorization: signApproval({ request: forged, decision: 'rejected', decidedBy: 'test-approver@example.com' }),
    }),
    /is already 'approved', not 'pending'/
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
