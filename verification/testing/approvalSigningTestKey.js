'use strict';

// A REAL Ed25519 approval signer for the test suite.
//
// WHAT THIS IS, PRECISELY. It is a stand-in for the HUMAN, not for the verifier. The
// keypair below is genuine, the challenge comes from the real
// approvals/approvalArchitecture.js, and the signature is produced by real
// crypto.sign(). approvals/approvalWorkflow.js then verifies it through the real
// verifyApprovalAuthorization() with no stubbing anywhere: every check - key configured,
// challenge issued here, not consumed, not expired, bound to this exact request/decision/
// approver, payload unchanged, signature valid - runs exactly as it does in production.
//
// WHY THAT MATTERS. Mocking verification would make these tests prove nothing: the whole
// point of the mechanism is that a signature cannot be produced without the private key, so
// a suite that skips signing would pass whether or not the gate worked. Here the ONLY way
// any test gets an approval recorded is by actually signing the real payload.
//
// THE PRIVATE KEY IS EPHEMERAL AND TEST-ONLY. It is generated in memory at require time,
// never written to disk, never printed, and never leaves this process. It is not the
// project's key and cannot be: production configures only a public key, and no project file
// generates a keypair (see approvals/approvalArchitecture.js's own header). A real deployment's
// private key lives with the approver, off the server entirely.

const crypto = require('node:crypto');
const {
  APPROVAL_PUBLIC_KEY_ENV,
  issueApprovalChallenge,
} = require('../../approvals/approvalArchitecture');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

const APPROVAL_TEST_PUBLIC_KEY_PEM = publicKey.export({ type: 'spki', format: 'pem' });

// Configures this process to verify against the test public key. Called at require time so
// simply importing this helper is enough; exported too, for a suite that clears or
// overwrites the environment partway through and needs to restore it.
function useApprovalTestKey() {
  process.env[APPROVAL_PUBLIC_KEY_ENV] = APPROVAL_TEST_PUBLIC_KEY_PEM;
  return APPROVAL_TEST_PUBLIC_KEY_PEM;
}

useApprovalTestKey();

// Produces a genuine signed authorization for one pending approval record, exactly as a
// human would: ask the server for the challenge, sign its payload, hand back
// { nonce, signature }.
//
// `request` must be the REAL pending record (the one held in the requests array), because
// the challenge binds to its execution_request fingerprint - signing against a hand-built
// look-alike would correctly fail verification.
function signApproval({ request, decision = 'approved', decidedBy = 'test-approver@example.com' } = {}) {
  const challenge = issueApprovalChallenge({ request, decision, decidedBy });
  const signature = crypto.sign(null, Buffer.from(challenge.payload, 'utf8'), privateKey).toString('base64');
  return { nonce: challenge.nonce, signature };
}

// The same, but signed with a DIFFERENT key - a signature that is well-formed and covers the
// right payload, yet was not produced by the configured approver. Used to prove the gate
// checks the key and not merely the shape.
function signApprovalWithForeignKey({ request, decision = 'approved', decidedBy = 'test-approver@example.com' } = {}) {
  const foreign = crypto.generateKeyPairSync('ed25519');
  const challenge = issueApprovalChallenge({ request, decision, decidedBy });
  const signature = crypto.sign(null, Buffer.from(challenge.payload, 'utf8'), foreign.privateKey).toString('base64');
  return { nonce: challenge.nonce, signature };
}

// Convenience for the many suites that just need "approve this record, for real".
function approvedAuthorizationFor(request, decidedBy = 'test-approver@example.com') {
  return signApproval({ request, decision: 'approved', decidedBy });
}

function rejectedAuthorizationFor(request, decidedBy = 'test-approver@example.com') {
  return signApproval({ request, decision: 'rejected', decidedBy });
}

// The uniform adapter used across the existing approval suites: takes the SAME options a
// call already passed to decideApprovalRequest/decideComplianceGatedApproval and returns
// them with a genuine `authorization` attached, signed for that exact record, decision and
// approver.
//
// Returns the options UNCHANGED when the record is not in the array, or when the options are
// already invalid (no decision, blank decidedBy, wrong status). Those are the suite's own
// error-path cases, and decideApprovalRequest checks every one of them BEFORE the provenance
// gate - so leaving them unsigned keeps them hitting the error they were written to prove
// rather than masking it behind an authorization failure.
function signedDecision(requests, requestId, options = {}) {
  if (!Array.isArray(requests)) return options;
  const request = requests.find((entry) => entry && entry.id === requestId);
  if (!request || request.status !== 'pending') return options;
  const { decision, decidedBy } = options;
  if (decision !== 'approved' && decision !== 'rejected') return options;
  if (typeof decidedBy !== 'string' || decidedBy.trim() === '') return options;
  return { ...options, authorization: signApproval({ request, decision, decidedBy: decidedBy.trim() }) };
}

// Signs an arbitrary challenge payload string. Used by the HTTP endpoint suites, which get
// their payload back from GET /approval-challenge over the wire and must sign that exact
// string - the same thing a person does at their own terminal.
function signPayloadString(payload) {
  return crypto.sign(null, Buffer.from(String(payload), 'utf8'), privateKey).toString('base64');
}

module.exports = {
  APPROVAL_TEST_PUBLIC_KEY_PEM,
  signedDecision,
  signPayloadString,
  useApprovalTestKey,
  signApproval,
  signApprovalWithForeignKey,
  approvedAuthorizationFor,
  rejectedAuthorizationFor,
};
