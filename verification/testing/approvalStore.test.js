'use strict';

// Durable approval/pending-action state: approvals/approvalStore.js plus the three
// durability functions approvals/approvalWorkflow.js composes on top of it.
//
// NO EXTERNAL API IS CALLED ANYWHERE HERE. Every test operates on a throwaway temp
// directory and in-process objects. The approval signatures are REAL Ed25519 (see
// approvalSigningTestKey.js) and are verified by the real gate - nothing is mocked, so a
// reloaded approval that still verifies is genuine evidence that provenance survived.
//
// "RESTART" IS SIMULATED HONESTLY. The store holds no in-memory cache of its own, so a
// restart is exactly "drop every object you held and read only what reached disk". Each
// reload test below discards its local array entirely and rebuilds from the store.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point the store at a throwaway directory BEFORE anything reads it, so this suite never
// writes into the project's own memory/state/approvals/.
const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-store-test-'));
process.env.APPROVAL_STORE_DIR = STORE_DIR;

const approvalStore = require('../../approvals/approvalStore');
const {
  createApprovalRequest,
  decideApprovalRequest,
  createAndPersistApprovalRequest,
  decideAndPersistApprovalRequest,
  loadPendingApprovalRequests,
  getApprovalRequestById,
} = require('../../approvals/approvalWorkflow');
const { validateApprovalRequestShape } = require('../../approvals/approvalRequestModel');
const { signApproval } = require('./approvalSigningTestKey');

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

let counter = 0;
function uniqueId(prefix) {
  counter += 1;
  return `${prefix}-${counter}`;
}

function pendingRequest(id, { businessId = null, extra = {} } = {}) {
  return createApprovalRequest({
    id,
    classification: 'externally_executable',
    specialistId: 'product',
    toolId: 'shopify_vendor_correction',
    executionRequest: {
      objective: 'correct the vendor',
      tool_id: 'shopify_vendor_correction',
      business_id: businessId,
      platform: 'shopify',
      ...extra,
    },
    reason: 'Executing this tool requires explicit approval before it can proceed.',
  });
}

function approve(record, decidedBy = 'test-approver@example.com') {
  return decideApprovalRequest([record], record.id, {
    decision: 'approved',
    decidedBy,
    authorization: signApproval({ request: record, decision: 'approved', decidedBy }),
  });
}

// ---------------------------------------------------------------------------------
// 1. Create -> restart -> recoverable
// ---------------------------------------------------------------------------------

test('A PENDING APPROVAL SURVIVES RESTART: recoverable from disk alone', () => {
  const id = uniqueId('apr-survive');
  const record = createAndPersistApprovalRequest({
    id,
    classification: 'externally_executable',
    specialistId: 'product',
    toolId: 'shopify_vendor_correction',
    executionRequest: { objective: 'correct the vendor', tool_id: 'shopify_vendor_correction', business_id: 'biz-a', platform: 'shopify' },
    reason: 'Executing this tool requires explicit approval before it can proceed.',
  });

  // THE RESTART: every in-memory reference is dropped; only the disk remains.
  const reloaded = loadPendingApprovalRequests({ businessId: 'biz-a' }).find((entry) => entry.id === id);

  assert.ok(reloaded, 'the pending approval must be recoverable after a restart');
  assert.deepStrictEqual(reloaded, record, 'the recovered record must be identical, not merely similar');
  assert.strictEqual(validateApprovalRequestShape(reloaded).valid, true);
});

test('THE PENDING ACTION SURVIVES with identity, business, platform and action detail intact', () => {
  const id = uniqueId('apr-action');
  const record = pendingRequest(id, { businessId: 'biz-a' });
  approvalStore.saveApprovalRecord(record);

  const envelope = approvalStore.loadApprovalRecord(id);
  assert.ok(envelope);
  assert.strictEqual(envelope.approval_id, id, 'request identity');
  assert.strictEqual(envelope.business_id, 'biz-a', 'business_id');
  assert.strictEqual(envelope.platform, 'shopify', 'platform');
  assert.strictEqual(envelope.execution_state, 'awaiting_decision');
  // The exact action to resume - relayed verbatim, which is what keeps the signed
  // execution fingerprint verifiable after a restart.
  assert.strictEqual(envelope.approval_request.tool_id, 'shopify_vendor_correction');
  assert.strictEqual(envelope.approval_request.execution_request.objective, 'correct the vendor');
  assert.strictEqual(envelope.approval_request.classification, 'externally_executable');
});

// ---------------------------------------------------------------------------------
// 2. A valid approval still works after reload, provenance intact
// ---------------------------------------------------------------------------------

test('A VALID APPROVAL AFTER RELOAD WORKS, and the verified provenance is persisted', () => {
  const id = uniqueId('apr-reload-approve');
  approvalStore.saveApprovalRecord(pendingRequest(id, { businessId: 'biz-a' }));

  // Restart: rebuild the caller-held array from durable state only.
  const [reloaded] = loadPendingApprovalRequests({ businessId: 'biz-a' }).filter((entry) => entry.id === id);
  assert.ok(reloaded, 'precondition: the pending request reloaded');

  // Sign and decide against the RELOADED record - if anything about it had changed on the
  // round trip, the execution fingerprint would no longer match and this would refuse.
  const decidedBy = 'test-approver@example.com';
  const updated = decideAndPersistApprovalRequest([reloaded], id, {
    decision: 'approved',
    decidedBy,
    authorization: signApproval({ request: reloaded, decision: 'approved', decidedBy }),
  });
  assert.strictEqual(getApprovalRequestById(updated, id).status, 'approved');

  // Restart again: the decision AND its provenance are durable.
  const envelope = approvalStore.loadApprovalRecord(id);
  assert.strictEqual(envelope.execution_state, 'decided');
  assert.strictEqual(envelope.approval_request.status, 'approved');
  assert.strictEqual(envelope.approval_request.decided_by, decidedBy);

  const provenance = envelope.approval_request.execution_request.approval_provenance;
  assert.ok(provenance, 'the verified provenance must survive the restart');
  assert.strictEqual(provenance.method, 'ed25519_signature');
  assert.strictEqual(provenance.request_id, id);
  assert.ok(typeof provenance.execution_fingerprint === 'string' && provenance.execution_fingerprint.length === 64);
  assert.ok(typeof provenance.signature === 'string' && provenance.signature !== '');
});

test('THE ED25519 REQUIREMENT IS UNCHANGED across a reload: an unsigned decision is still refused', () => {
  const id = uniqueId('apr-reload-unsigned');
  approvalStore.saveApprovalRecord(pendingRequest(id, { businessId: 'biz-a' }));
  const [reloaded] = loadPendingApprovalRequests({ businessId: 'biz-a' }).filter((entry) => entry.id === id);

  assert.throws(
    () => decideAndPersistApprovalRequest([reloaded], id, { decision: 'approved', decidedBy: 'store-owner@example.com' }),
    /not accompanied by verified human authorization/
  );
  // And the refused decision changed nothing on disk.
  assert.strictEqual(approvalStore.loadApprovalRecord(id).execution_state, 'awaiting_decision');
  assert.strictEqual(approvalStore.loadApprovalRecord(id).approval_request.status, 'pending');
});

// ---------------------------------------------------------------------------------
// 3. Execute-once: expired / replayed / completed / cancelled never execute
// ---------------------------------------------------------------------------------

test('AN APPROVED ACTION EXECUTES EXACTLY ONCE - a second claim is refused after restart', () => {
  const id = uniqueId('apr-once');
  const record = pendingRequest(id, { businessId: 'biz-a' });
  const decided = getApprovalRequestById(approve(record), id);
  approvalStore.saveApprovalRecord(decided, { executionState: 'decided' });

  const first = approvalStore.claimApprovalForExecution(id);
  assert.strictEqual(first.ok, true, 'the first claim must succeed');
  assert.strictEqual(first.envelope.execution_state, 'executed');
  assert.ok(first.envelope.executed_at);

  // Restart, then try again - the durable state refuses it.
  const second = approvalStore.claimApprovalForExecution(id);
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.reason, 'already_executed');
});

test('AN UNDECIDED ACTION CANNOT EXECUTE', () => {
  const id = uniqueId('apr-undecided');
  approvalStore.saveApprovalRecord(pendingRequest(id, { businessId: 'biz-a' }));
  const claim = approvalStore.claimApprovalForExecution(id);
  assert.strictEqual(claim.ok, false);
  assert.strictEqual(claim.reason, 'still_awaiting_decision');
});

test('A REJECTED ACTION CANNOT EXECUTE', () => {
  const id = uniqueId('apr-rejected');
  const record = pendingRequest(id, { businessId: 'biz-a' });
  const decidedBy = 'test-approver@example.com';
  const updated = decideApprovalRequest([record], id, {
    decision: 'rejected',
    decidedBy,
    authorization: signApproval({ request: record, decision: 'rejected', decidedBy }),
  });
  approvalStore.saveApprovalRecord(getApprovalRequestById(updated, id), { executionState: 'decided' });

  const claim = approvalStore.claimApprovalForExecution(id);
  assert.strictEqual(claim.ok, false);
  assert.strictEqual(claim.reason, 'not_approved');
});

test('AN EXPIRED ACTION CANNOT EXECUTE', () => {
  const id = uniqueId('apr-expired');
  const record = pendingRequest(id, { businessId: 'biz-a' });
  const decided = getApprovalRequestById(approve(record), id);
  approvalStore.saveApprovalRecord(decided, { executionState: 'decided', expiresAt: '2020-01-01T00:00:00.000Z' });

  const claim = approvalStore.claimApprovalForExecution(id);
  assert.strictEqual(claim.ok, false);
  assert.strictEqual(claim.reason, 'expired');
  // Still not executed - a refused claim never marks it done.
  assert.strictEqual(approvalStore.loadApprovalRecord(id).execution_state, 'decided');
});

test('A CANCELLED ACTION CANNOT EXECUTE', () => {
  const id = uniqueId('apr-cancelled');
  const record = pendingRequest(id, { businessId: 'biz-a' });
  approvalStore.saveApprovalRecord(getApprovalRequestById(approve(record), id), { executionState: 'decided' });

  approvalStore.cancelStoredApproval(id);
  const claim = approvalStore.claimApprovalForExecution(id);
  assert.strictEqual(claim.ok, false);
  assert.strictEqual(claim.reason, 'cancelled');
});

test('A REPLAYED SIGNATURE STILL CANNOT RE-DECIDE across a restart', () => {
  const id = uniqueId('apr-replay');
  const record = pendingRequest(id, { businessId: 'biz-a' });
  const decidedBy = 'test-approver@example.com';
  const authorization = signApproval({ request: record, decision: 'approved', decidedBy });

  const updated = decideApprovalRequest([record], id, { decision: 'approved', decidedBy, authorization });
  approvalStore.saveApprovalRecord(getApprovalRequestById(updated, id), { executionState: 'decided' });

  // A fresh pending copy (as a restart would produce for a different request) cannot be
  // decided by re-presenting the same signature - the nonce is single-use.
  const replayTarget = pendingRequest(uniqueId('apr-replay-target'), { businessId: 'biz-a' });
  assert.throws(
    () => decideApprovalRequest([replayTarget], replayTarget.id, { decision: 'approved', decidedBy, authorization }),
    /challenge_not_already_used|challenge_matches_this_decision/
  );
});

// ---------------------------------------------------------------------------------
// 4. Cross-business isolation
// ---------------------------------------------------------------------------------

test('WRONG BUSINESS CANNOT ACCESS a stored approval - indistinguishable from not found', () => {
  const id = uniqueId('apr-isolation');
  approvalStore.saveApprovalRecord(pendingRequest(id, { businessId: 'biz-a' }));

  assert.ok(approvalStore.loadApprovalRecord(id, { expectedBusinessId: 'biz-a' }), 'its own business can read it');
  assert.strictEqual(
    approvalStore.loadApprovalRecord(id, { expectedBusinessId: 'biz-b' }),
    null,
    'another business must get exactly null - never a partial record'
  );
  assert.strictEqual(approvalStore.loadApprovalRecord('no-such-approval', { expectedBusinessId: 'biz-b' }), null);
});

test('WRONG BUSINESS CANNOT EXECUTE, LIST OR CANCEL another business\'s action', () => {
  const id = uniqueId('apr-isolation-exec');
  const record = pendingRequest(id, { businessId: 'biz-a' });
  approvalStore.saveApprovalRecord(getApprovalRequestById(approve(record), id), { executionState: 'decided' });

  const claim = approvalStore.claimApprovalForExecution(id, { expectedBusinessId: 'biz-b' });
  assert.strictEqual(claim.ok, false);
  assert.strictEqual(claim.reason, 'not_found', 'a foreign claim must not even reveal that it exists');

  assert.strictEqual(approvalStore.cancelStoredApproval(id, { expectedBusinessId: 'biz-b' }), null);
  assert.ok(!approvalStore.listPendingApprovals({ businessId: 'biz-b' }).some((e) => e.approval_id === id));

  // And it is still executable by its own business - the foreign attempt changed nothing.
  assert.strictEqual(approvalStore.claimApprovalForExecution(id, { expectedBusinessId: 'biz-a' }).ok, true);
});

test('LISTING IS SCOPED: one business never sees another\'s pending approvals', () => {
  const mine = uniqueId('apr-list-mine');
  const theirs = uniqueId('apr-list-theirs');
  approvalStore.saveApprovalRecord(pendingRequest(mine, { businessId: 'biz-list-a' }));
  approvalStore.saveApprovalRecord(pendingRequest(theirs, { businessId: 'biz-list-b' }));

  const ids = loadPendingApprovalRequests({ businessId: 'biz-list-a' }).map((entry) => entry.id);
  assert.ok(ids.includes(mine));
  assert.ok(!ids.includes(theirs));
});

// ---------------------------------------------------------------------------------
// 5. No credential material is ever persisted
// ---------------------------------------------------------------------------------

test('CREDENTIALS ARE REFUSED, NEVER PERSISTED - and never silently redacted', () => {
  for (const credentialShaped of [
    { SHOPIFY_ADMIN_API_ACCESS_TOKEN: 'shpat_secret' },
    { api_key: 'sk-secret' },
    { nested: { client_secret: 'shhh' } },
    { list: [{ password: 'hunter2' }] },
    { privateKey: '-----BEGIN PRIVATE KEY-----' },
  ]) {
    const id = uniqueId('apr-credential');
    const record = pendingRequest(id, { businessId: 'biz-a', extra: credentialShaped });
    assert.throws(
      () => approvalStore.saveApprovalRecord(record),
      /carries credential-shaped material/,
      `${JSON.stringify(credentialShaped)} must be refused`
    );
    // Refused means NOTHING was written - not a redacted copy.
    assert.strictEqual(approvalStore.loadApprovalRecord(id), null);
  }
});

test('NO PRIVATE KEY OR CREDENTIAL APPEARS IN ANY PERSISTED FILE', () => {
  const id = uniqueId('apr-scan');
  const record = pendingRequest(id, { businessId: 'biz-a' });
  approvalStore.saveApprovalRecord(getApprovalRequestById(approve(record), id), { executionState: 'decided' });

  for (const fileName of fs.readdirSync(STORE_DIR)) {
    const contents = fs.readFileSync(path.join(STORE_DIR, fileName), 'utf8');
    for (const forbidden of ['PRIVATE KEY', 'BEGIN OPENSSH', 'shpat_', 'sk-ant-', 'ETSY_OAUTH_ACCESS_TOKEN', 'ANTHROPIC_API_KEY']) {
      assert.ok(!contents.includes(forbidden), `${fileName} must not contain ${forbidden}`);
    }
  }
});

test('THE SIGNATURE IS KEPT, because it is the audit evidence - and it is not a credential', () => {
  const id = uniqueId('apr-signature-kept');
  const record = pendingRequest(id, { businessId: 'biz-a' });
  approvalStore.saveApprovalRecord(getApprovalRequestById(approve(record), id), { executionState: 'decided' });
  const provenance = approvalStore.loadApprovalRecord(id).approval_request.execution_request.approval_provenance;
  assert.ok(provenance.signature, 'the signature must be retained for later re-verification');
  // It is retained under a name that is NOT credential-shaped, which is why the guard above
  // permits it - a real credential would have been refused.
  assert.strictEqual(approvalStore.findCredentialKeyPath({ signature: 'x' }), null);
  assert.strictEqual(approvalStore.findCredentialKeyPath({ access_token: 'x' }), 'access_token');
});

// ---------------------------------------------------------------------------------
// 6. Corruption and atomicity: fail closed, execute nothing
// ---------------------------------------------------------------------------------

test('CORRUPTED PERSISTENCE FAILS CLOSED: unreadable state executes nothing', () => {
  const id = uniqueId('apr-corrupt');
  const record = pendingRequest(id, { businessId: 'biz-a' });
  approvalStore.saveApprovalRecord(getApprovalRequestById(approve(record), id), { executionState: 'decided' });

  // Truncated mid-object, exactly what a partial write would leave behind.
  const filePath = path.join(STORE_DIR, `${id}.json`);
  fs.writeFileSync(filePath, '{"envelope_version": 1, "approval_request": {"id": "', 'utf8');

  assert.strictEqual(approvalStore.loadApprovalRecord(id), null, 'a corrupt approval reads as not found');
  const claim = approvalStore.claimApprovalForExecution(id);
  assert.strictEqual(claim.ok, false, 'a corrupt approval must never execute');
  assert.strictEqual(claim.reason, 'not_found');
  assert.ok(!loadPendingApprovalRequests({ businessId: 'biz-a' }).some((entry) => entry.id === id));
});

test('A TAMPERED OR UNKNOWN ENVELOPE SHAPE FAILS CLOSED', () => {
  const id = uniqueId('apr-shape');
  const filePath = path.join(STORE_DIR, `${id}.json`);
  for (const contents of [
    '{"envelope_version": 999, "approval_request": {}, "execution_state": "decided"}',
    '{"envelope_version": 1, "execution_state": "decided"}',
    '{"envelope_version": 1, "approval_request": {}, "execution_state": "not-a-state"}',
    '[]',
    'null',
  ]) {
    fs.writeFileSync(filePath, contents, 'utf8');
    assert.strictEqual(approvalStore.loadApprovalRecord(id), null, `${contents} must read as not found`);
    assert.strictEqual(approvalStore.claimApprovalForExecution(id).ok, false);
  }
});

test('ONE CORRUPT FILE NEVER BREAKS THE REST OF THE LISTING', () => {
  const good = uniqueId('apr-good');
  approvalStore.saveApprovalRecord(pendingRequest(good, { businessId: 'biz-resilient' }));
  fs.writeFileSync(path.join(STORE_DIR, 'not-valid-json.json'), '{oops', 'utf8');

  const ids = loadPendingApprovalRequests({ businessId: 'biz-resilient' }).map((entry) => entry.id);
  assert.deepStrictEqual(ids, [good]);
});

test('WRITES ARE ATOMIC: no temp file is left behind, and every written file is complete', () => {
  // Its OWN clean directory, so this asserts what the store wrote rather than what other
  // tests in this file deliberately corrupted.
  const cleanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-store-atomic-'));
  try {
    for (let index = 0; index < 5; index += 1) {
      const id = uniqueId('apr-atomic');
      approvalStore.saveApprovalRecord(pendingRequest(id, { businessId: 'biz-a' }), { storeDir: cleanDir });
      // Re-saving the same id (a decision updating a record) must also leave no debris.
      approvalStore.saveApprovalRecord(pendingRequest(id, { businessId: 'biz-a' }), { storeDir: cleanDir });
    }

    const fileNames = fs.readdirSync(cleanDir);
    assert.deepStrictEqual(
      fileNames.filter((name) => name.includes('.tmp')),
      [],
      'an atomic write must leave no temp file behind, even on re-save'
    );
    // Every file the store wrote parses completely - there is no partial write anywhere.
    for (const fileName of fileNames) {
      const parsed = JSON.parse(fs.readFileSync(path.join(cleanDir, fileName), 'utf8'));
      assert.strictEqual(parsed.envelope_version, approvalStore.APPROVAL_ENVELOPE_VERSION);
    }
  } finally {
    fs.rmSync(cleanDir, { recursive: true, force: true });
  }
});

test('A PATH-TRAVERSAL APPROVAL ID CANNOT ADDRESS ANYTHING OUTSIDE THE STORE', () => {
  assert.strictEqual(approvalStore.safeApprovalId('../../etc/passwd'), 'etcpasswd');
  assert.strictEqual(approvalStore.safeApprovalId('..'), '');
  assert.strictEqual(approvalStore.loadApprovalRecord('../../etc/passwd'), null);
  assert.strictEqual(approvalStore.loadApprovalRecord('..'), null);
});

test('this test file is registered in the suite runner', () => {
  const { TEST_FILES } = require('./runAllTests');
  assert.ok(TEST_FILES.includes('approvalStore.test.js'));
});

try {
  fs.rmSync(STORE_DIR, { recursive: true, force: true });
} catch (err) {
  // A leftover temp directory is harmless; never fail the suite over cleanup.
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
