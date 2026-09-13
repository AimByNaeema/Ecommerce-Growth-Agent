'use strict';

const assert = require('node:assert');
const {
  ACTION_CLASSIFICATIONS,
  APPROVAL_POLICY_RULES,
  AUTO_APPROVED_CLASSIFICATIONS,
  getClassificationById,
  requiresApproval,
} = require('../../approvals/approvalArchitecture');

const EXPECTED_CLASSIFICATIONS = [
  'analysis_only',
  'recommendation',
  'approval_required',
  'externally_executable',
];

const EXPECTED_POLICY_RULES = ['approval_required_by_default', 'never_silent_consequential_action'];

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

test('the 4 required classifications exist, in the requested order', () => {
  assert.deepStrictEqual(
    ACTION_CLASSIFICATIONS.map((entry) => entry.id),
    EXPECTED_CLASSIFICATIONS
  );
});

test('the 2 required policy rules exist, in the requested order', () => {
  assert.deepStrictEqual(
    APPROVAL_POLICY_RULES.map((rule) => rule.id),
    EXPECTED_POLICY_RULES
  );
});

test('every classification has a non-empty title and description', () => {
  for (const entry of ACTION_CLASSIFICATIONS) {
    assert.ok(entry.title && entry.title.trim() !== '', `${entry.id} is missing a title`);
    assert.ok(entry.description && entry.description.trim() !== '', `${entry.id} is missing a description`);
  }
});

test('every policy rule has a non-empty description', () => {
  for (const rule of APPROVAL_POLICY_RULES) {
    assert.ok(rule.description && rule.description.trim() !== '', `${rule.id} is missing a description`);
  }
});

test('ids are unique across classifications and policy rules combined', () => {
  const ids = [...ACTION_CLASSIFICATIONS, ...APPROVAL_POLICY_RULES].map((entry) => entry.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

test('getClassificationById() finds a known entry and returns undefined for an unknown one', () => {
  assert.strictEqual(getClassificationById('externally_executable').title, 'Externally executable');
  assert.strictEqual(getClassificationById('does_not_exist'), undefined);
});

test('AUTO_APPROVED_CLASSIFICATIONS is exactly analysis_only and recommendation', () => {
  assert.deepStrictEqual(AUTO_APPROVED_CLASSIFICATIONS, ['analysis_only', 'recommendation']);
});

test('requiresApproval is false for the two auto-approved classifications', () => {
  assert.strictEqual(requiresApproval('analysis_only'), false);
  assert.strictEqual(requiresApproval('recommendation'), false);
});

test('requiresApproval is true for approval_required and externally_executable', () => {
  assert.strictEqual(requiresApproval('approval_required'), true);
  assert.strictEqual(requiresApproval('externally_executable'), true);
});

test('requiresApproval is true (never auto-approved) for null or an unknown classification', () => {
  assert.strictEqual(requiresApproval(null), true);
  assert.strictEqual(requiresApproval(undefined), true);
  assert.strictEqual(requiresApproval('not_a_real_classification'), true);
});

// ===================================================================================
// HUMAN APPROVAL PROVENANCE - real Ed25519, real verification, nothing mocked.
// ===================================================================================
//
// NO EXTERNAL CALL IS MADE BELOW. Every operation is local crypto over local objects.

const crypto = require('node:crypto');
const {
  APPROVAL_PUBLIC_KEY_ENV,
  APPROVAL_PAYLOAD_VERSION,
  computeExecutionFingerprint,
  getConfiguredApprovalPublicKey,
  issueApprovalChallenge,
  verifyApprovalAuthorization,
  clearIssuedApprovalChallenges,
} = require('../../approvals/approvalArchitecture');

const realKeys = crypto.generateKeyPairSync('ed25519');
const REAL_PUBLIC_PEM = realKeys.publicKey.export({ type: 'spki', format: 'pem' });

function pendingRecord(overrides = {}) {
  return {
    id: 'apr-prov-1',
    status: 'pending',
    execution_request: { objective: 'publish the thing', tool_id: 'shopify_vendor_correction' },
    ...overrides,
  };
}

function withPublicKey(pem, fn) {
  const saved = process.env[APPROVAL_PUBLIC_KEY_ENV];
  if (pem === null) delete process.env[APPROVAL_PUBLIC_KEY_ENV];
  else process.env[APPROVAL_PUBLIC_KEY_ENV] = pem;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[APPROVAL_PUBLIC_KEY_ENV];
    else process.env[APPROVAL_PUBLIC_KEY_ENV] = saved;
  }
}

function sign(payload, key = realKeys.privateKey) {
  return crypto.sign(null, Buffer.from(payload, 'utf8'), key).toString('base64');
}

test('THE HAPPY PATH: a genuinely signed decision verifies', () => {
  withPublicKey(REAL_PUBLIC_PEM, () => {
    const request = pendingRecord();
    const challenge = issueApprovalChallenge({ request, decision: 'approved', decidedBy: 'owner@example.com' });
    const result = verifyApprovalAuthorization({
      request,
      decision: 'approved',
      decidedBy: 'owner@example.com',
      authorization: { nonce: challenge.nonce, signature: sign(challenge.payload) },
    });
    assert.strictEqual(result.verified, true);
    assert.strictEqual(result.provenance.method, 'ed25519_signature');
    assert.strictEqual(result.provenance.payload_version, APPROVAL_PAYLOAD_VERSION);
    assert.strictEqual(result.provenance.decided_by, 'owner@example.com');
    assert.strictEqual(result.provenance.execution_fingerprint, computeExecutionFingerprint(request.execution_request));
  });
});

test('AN AGENT CANNOT APPROVE ITS OWN ACTION: no signature is refused, however complete the claim', () => {
  withPublicKey(REAL_PUBLIC_PEM, () => {
    const request = pendingRecord();
    // Everything an in-process caller could fabricate: a name, a title, a timestamp, a
    // plausible-looking "human" flag. None of it is a signature.
    for (const authorization of [
      undefined,
      null,
      {},
      { decidedBy: 'store-owner@example.com' },
      { human: true, approved_by_human: true, decidedBy: 'the owner' },
      { nonce: 'made-up', signature: '' },
      { nonce: '', signature: 'made-up' },
      'a string',
      42,
    ]) {
      const result = verifyApprovalAuthorization({
        request,
        decision: 'approved',
        decidedBy: 'store-owner@example.com',
        authorization,
      });
      assert.strictEqual(result.verified, false, `${JSON.stringify(authorization)} must not verify`);
    }
  });
});

test('A FORGED SIGNATURE IS REFUSED: right shape, wrong key', () => {
  withPublicKey(REAL_PUBLIC_PEM, () => {
    const request = pendingRecord();
    const challenge = issueApprovalChallenge({ request, decision: 'approved', decidedBy: 'owner@example.com' });
    const foreign = crypto.generateKeyPairSync('ed25519');
    const result = verifyApprovalAuthorization({
      request,
      decision: 'approved',
      decidedBy: 'owner@example.com',
      authorization: { nonce: challenge.nonce, signature: sign(challenge.payload, foreign.privateKey) },
    });
    assert.strictEqual(result.verified, false);
    assert.strictEqual(result.failed_check, 'signature_verifies_under_public_key');
  });
});

test('A REPLAYED SIGNATURE IS REFUSED: one signature authorizes exactly one decision', () => {
  withPublicKey(REAL_PUBLIC_PEM, () => {
    const request = pendingRecord();
    const challenge = issueApprovalChallenge({ request, decision: 'approved', decidedBy: 'owner@example.com' });
    const authorization = { nonce: challenge.nonce, signature: sign(challenge.payload) };
    assert.strictEqual(
      verifyApprovalAuthorization({ request, decision: 'approved', decidedBy: 'owner@example.com', authorization }).verified,
      true
    );
    const replay = verifyApprovalAuthorization({ request, decision: 'approved', decidedBy: 'owner@example.com', authorization });
    assert.strictEqual(replay.verified, false);
    assert.strictEqual(replay.failed_check, 'challenge_not_already_used');
  });
});

test('A TAMPERED ACTION IS REFUSED: the signature covers the exact execution request', () => {
  withPublicKey(REAL_PUBLIC_PEM, () => {
    const request = pendingRecord();
    const challenge = issueApprovalChallenge({ request, decision: 'approved', decidedBy: 'owner@example.com' });
    const authorization = { nonce: challenge.nonce, signature: sign(challenge.payload) };
    // The action is swapped after the human signed for the original one.
    const tampered = pendingRecord({ execution_request: { objective: 'publish something else', tool_id: 'shopify_vendor_correction' } });
    const result = verifyApprovalAuthorization({
      request: tampered,
      decision: 'approved',
      decidedBy: 'owner@example.com',
      authorization,
    });
    assert.strictEqual(result.verified, false);
    assert.strictEqual(result.failed_check, 'payload_matches_challenge');
  });
});

test('A REDIRECTED SIGNATURE IS REFUSED: bound to one request, decision and approver', () => {
  withPublicKey(REAL_PUBLIC_PEM, () => {
    const request = pendingRecord();
    const challenge = issueApprovalChallenge({ request, decision: 'rejected', decidedBy: 'owner@example.com' });
    const authorization = { nonce: challenge.nonce, signature: sign(challenge.payload) };

    // Signed to REJECT - it cannot be turned into an approval.
    const flipped = verifyApprovalAuthorization({ request, decision: 'approved', decidedBy: 'owner@example.com', authorization });
    assert.strictEqual(flipped.verified, false);
    assert.strictEqual(flipped.failed_check, 'challenge_matches_this_decision');

    // Nor re-attributed to a different approver, nor pointed at a different request.
    const other = verifyApprovalAuthorization({ request, decision: 'rejected', decidedBy: 'someone-else@example.com', authorization });
    assert.strictEqual(other.verified, false);
    const otherRequest = verifyApprovalAuthorization({
      request: pendingRecord({ id: 'apr-prov-2' }),
      decision: 'rejected',
      decidedBy: 'owner@example.com',
      authorization,
    });
    assert.strictEqual(otherRequest.verified, false);
  });
});

test('AN INVENTED NONCE IS REFUSED: only a challenge this server issued counts', () => {
  withPublicKey(REAL_PUBLIC_PEM, () => {
    const request = pendingRecord();
    const result = verifyApprovalAuthorization({
      request,
      decision: 'approved',
      decidedBy: 'owner@example.com',
      authorization: { nonce: 'a-nonce-nobody-issued', signature: sign('anything') },
    });
    assert.strictEqual(result.verified, false);
    assert.strictEqual(result.failed_check, 'challenge_issued_by_this_server');
  });
});

test('AN EXPIRED CHALLENGE IS REFUSED', () => {
  const savedTtl = process.env.APPROVAL_CHALLENGE_TTL_MS;
  process.env.APPROVAL_CHALLENGE_TTL_MS = '1';
  try {
    withPublicKey(REAL_PUBLIC_PEM, () => {
      const request = pendingRecord();
      const challenge = issueApprovalChallenge({ request, decision: 'approved', decidedBy: 'owner@example.com' });
      const authorization = { nonce: challenge.nonce, signature: sign(challenge.payload) };
      const deadline = Date.now() + 5;
      while (Date.now() < deadline) { /* let the 1ms window elapse */ }
      const result = verifyApprovalAuthorization({ request, decision: 'approved', decidedBy: 'owner@example.com', authorization });
      assert.strictEqual(result.verified, false);
      assert.strictEqual(result.failed_check, 'challenge_not_expired');
    });
  } finally {
    if (savedTtl === undefined) delete process.env.APPROVAL_CHALLENGE_TTL_MS;
    else process.env.APPROVAL_CHALLENGE_TTL_MS = savedTtl;
  }
});

test('FAILS CLOSED WITH NO KEY CONFIGURED: nothing can be approved at all', () => {
  withPublicKey(null, () => {
    const request = pendingRecord();
    const result = verifyApprovalAuthorization({
      request,
      decision: 'approved',
      decidedBy: 'owner@example.com',
      authorization: { nonce: 'x', signature: 'y' },
    });
    assert.strictEqual(result.verified, false);
    assert.strictEqual(result.failed_check, 'public_key_configured');
  });
});

test('A PRIVATE KEY IN THE PUBLIC KEY SETTING IS REFUSED OUTRIGHT', () => {
  const privatePem = realKeys.privateKey.export({ type: 'pkcs8', format: 'pem' });
  withPublicKey(privatePem, () => {
    assert.throws(() => getConfiguredApprovalPublicKey(), /contains a PRIVATE key/);
    const result = verifyApprovalAuthorization({
      request: pendingRecord(),
      decision: 'approved',
      decidedBy: 'owner@example.com',
      authorization: { nonce: 'x', signature: 'y' },
    });
    assert.strictEqual(result.verified, false);
    assert.strictEqual(result.failed_check, 'public_key_configured');
  });
});

test('THIS PROJECT NEVER GENERATES A KEYPAIR: no signing key can exist in the process', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const file of ['approvalArchitecture.js', 'approvalWorkflow.js', 'complianceApprovalGate.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'approvals', file), 'utf8');
    // Comments are stripped, and so is APPROVAL_SIGNING_INSTRUCTIONS - that constant is
    // documentation the OPERATOR runs on their own machine, quoted here so the instructions
    // cannot drift from the verification. Quoting the command as text is the opposite of
    // executing it; what this test forbids is this process ever doing key generation itself.
    const withoutInstructions = source.replace(
      /const APPROVAL_SIGNING_INSTRUCTIONS = \[[\s\S]*?\n\];/,
      'const APPROVAL_SIGNING_INSTRUCTIONS = [];'
    );
    const code = withoutInstructions
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    assert.ok(!code.includes('generateKeyPair'), `approvals/${file} must never generate a keypair`);
    assert.ok(!code.includes('createPrivateKey'), `approvals/${file} must never construct a private key`);
    assert.ok(!code.includes('crypto.sign('), `approvals/${file} must never sign anything`);
  }
});

test('the fingerprint is stable under key order and ignores the provenance it later carries', () => {
  const a = computeExecutionFingerprint({ objective: 'x', tool_id: 't', business_id: 'b' });
  const b = computeExecutionFingerprint({ business_id: 'b', tool_id: 't', objective: 'x' });
  assert.strictEqual(a, b, 'key order must not change the fingerprint');
  const withProvenance = computeExecutionFingerprint({
    objective: 'x',
    tool_id: 't',
    business_id: 'b',
    approval_provenance: { method: 'ed25519_signature' },
  });
  assert.strictEqual(a, withProvenance, 'recorded provenance must not invalidate the fingerprint');
  assert.notStrictEqual(a, computeExecutionFingerprint({ objective: 'y', tool_id: 't', business_id: 'b' }));
});

clearIssuedApprovalChallenges();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
