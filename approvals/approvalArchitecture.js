'use strict';

// The approval architecture for the ONE agent: how future actions are classified, and
// the policy governing when explicit human approval is required. Classification list
// + policy rules only - no classification engine, no execution logic, and no external
// service is connected anywhere in this file. `getClassificationById` is a read-only
// lookup, mirroring tools/toolRegistry.js's getToolById - it does not classify a real
// action, it only looks up one of the 4 defined classes by id.

const ACTION_CLASSIFICATIONS = [
  {
    id: 'analysis_only',
    title: 'Analysis-only',
    description:
      'Actions that only read/analyze existing data and produce a structured record (e.g. research, opportunity analysis, marketing analysis) - no external effect, no approval needed.',
  },
  {
    id: 'recommendation',
    title: 'Recommendation',
    description:
      'Actions that produce a suggestion for a human to consider (e.g. agent/core/listingOptimizationModel.js, agent/core/growthOpportunityModel.js records) - producing the suggestion needs no approval; acting on it does, per the classes below.',
  },
  {
    id: 'approval_required',
    title: 'Approval-required',
    description:
      'Actions that would change something (e.g. publishing content, applying a suggested listing title) but are not yet wired to an external system - must go through approvals/ for explicit human sign-off before proceeding.',
  },
  {
    id: 'externally_executable',
    title: 'Externally executable',
    description:
      'Actions that would call or change an external system (e.g. the connected Shopify store) - the most consequential class; always approval-required by default, and none can run today since no external service is connected yet.',
  },
];

// The policy governing when approval is required, regardless of which class an
// action falls into.
const APPROVAL_POLICY_RULES = [
  {
    id: 'approval_required_by_default',
    description:
      "External or potentially consequential actions (approval_required, externally_executable) require explicit approval before they proceed, unless a later, explicitly-scoped configuration setting permits otherwise. analysis_only and recommendation actions need no approval to produce their output.",
  },
  {
    id: 'never_silent_consequential_action',
    description:
      'The agent must never silently perform a consequential external action - if approval is missing, the action stops and is surfaced via approvals/, never executed quietly.',
  },
];

function getClassificationById(id) {
  return ACTION_CLASSIFICATIONS.find((entry) => entry.id === id);
}

// Classifications that may proceed automatically, per the 'approval_required_by_default'
// policy rule above. Anything else (approval_required, externally_executable, or no
// classification at all) requires explicit human approval before it proceeds -
// mechanically encoded by requiresApproval() below, rather than living only as prose.
// This is the single source of truth agent/core/toolPermissions.js reuses (never
// redefines) for its own AUTO_APPROVED_CLASSIFICATIONS re-export.
const AUTO_APPROVED_CLASSIFICATIONS = ['analysis_only', 'recommendation'];

function requiresApproval(classificationId) {
  return !classificationId || !AUTO_APPROVED_CLASSIFICATIONS.includes(classificationId);
}

// ===================================================================================
// HUMAN APPROVAL PROVENANCE - a decision must be PROVED human, not merely claimed.
// ===================================================================================
//
// THE HOLE THIS CLOSES. approvals/approvalWorkflow.js's decideApprovalRequest() used to
// accept any non-empty `decidedBy` STRING as evidence of an accountable human decision.
// A string is not evidence: the agent runs in this process, so it could write
// "store-owner@example.com" as easily as a person could, and approve its own pending
// action. Every downstream guarantee - approvals/publishAuthorization.js's nine checks,
// the compliance gate, the audit trail - rests on that decision being real, so this was
// the single load-bearing assumption in the whole chain with nothing behind it.
//
// WHAT MAKES PROVENANCE GENUINE HERE. The approver signs the decision with an Ed25519
// private key that EXISTS ONLY OUTSIDE THIS PROCESS. The server is configured with the
// PUBLIC key alone, which can verify a signature but cannot produce one. An agent that can
// read every file and environment variable this process can read therefore still cannot
// forge an approval - not because it is forbidden to, but because it does not possess and
// cannot derive the key. That is the difference between a policy and a proof.
//
// NO NEW DEPENDENCY, NO EXTERNAL SERVICE. Ed25519 sign/verify is in Node's built-in
// crypto. Nothing here calls out to anything; verification is local, offline and
// deterministic. The human's signing step is equally dependency-free (see
// APPROVAL_SIGNING_INSTRUCTIONS below).
//
// THE PRIVATE KEY IS NEVER GENERATED, STORED, LOGGED OR TRANSMITTED BY THIS PROJECT.
// There is deliberately no key-generation function anywhere in this codebase: generating
// the keypair here would mean the private half existed in this process, which is precisely
// what must never happen. The operator generates it themselves, keeps it off this machine,
// and configures only the public half.
//
// THE HONEST LIMIT, STATED PLAINLY. This raises forgery from "write a string" to "produce
// an Ed25519 signature over this exact decision without the key" - which is infeasible. It
// does NOT defend against code that subverts the verifier itself (monkey-patching crypto,
// pushing a hand-built record into the server-held array). That is a different threat -
// arbitrary code execution inside the trust boundary - and no in-process check can answer
// it. What this does guarantee is that an agent following its own tools, however
// autonomous, cannot approve its own action.

const crypto = require('node:crypto');

// The configuration naming the verification key. PUBLIC half only - the name says so, and
// getConfiguredApprovalPublicKey() refuses a private key outright (see below).
const APPROVAL_PUBLIC_KEY_ENV = 'APPROVAL_PUBLIC_KEY';

// How long a signing challenge stays valid. Short by design: a challenge is meant to be
// signed and returned in one sitting, and a narrow window limits how long a captured
// payload is worth anything. Overridable for a deployment with a slower human loop.
const DEFAULT_CHALLENGE_TTL_MS = 10 * 60 * 1000;
const CHALLENGE_TTL_ENV = 'APPROVAL_CHALLENGE_TTL_MS';

// The payload format version, carried in the signed string itself. A future format change
// therefore cannot be replayed against this one: the version is part of what was signed.
const APPROVAL_PAYLOAD_VERSION = 'ecom-approval-v1';

// What the operator actually does. Written here, next to the verification, so the two can
// never drift apart. No project file ever runs the first command.
const APPROVAL_SIGNING_INSTRUCTIONS = [
  '1. ONCE, on a machine that is NOT this server, generate the keypair:',
  "     node -e \"const c=require('crypto');const{publicKey,privateKey}=c.generateKeyPairSync('ed25519');" +
    "require('fs').writeFileSync('approval-private.pem',privateKey.export({type:'pkcs8',format:'pem'}));" +
    "console.log(publicKey.export({type:'spki',format:'pem'}))\"",
  `2. Put the printed PUBLIC key in the server's ${APPROVAL_PUBLIC_KEY_ENV}. Keep approval-private.pem off this machine.`,
  '3. To approve, request a challenge, then sign the EXACT payload string it returns:',
  "     node -e \"const c=require('crypto'),f=require('fs');" +
    "console.log(c.sign(null,Buffer.from(process.argv[1],'utf8')," +
    "c.createPrivateKey(f.readFileSync('approval-private.pem'))).toString('base64'))\" '<payload>'",
  '4. Paste the printed base64 signature into the approval form.',
];

// Deterministic JSON: object keys sorted at every depth, so the same execution request
// always produces the same fingerprint regardless of key insertion order. Without this a
// signature would verify or fail depending on how an object happened to be built.
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

// A stable fingerprint of the exact action being approved.
//
// `approval_provenance` is EXCLUDED because it is written into the execution request only
// AFTER a decision is verified - including it would make the fingerprint unverifiable the
// moment it was recorded. Everything else the caller will later re-run is covered, so an
// approval is bound to one specific action: change the objective, the tool, the content or
// the business, and the signature no longer matches.
function computeExecutionFingerprint(executionRequest) {
  const source = executionRequest && typeof executionRequest === 'object' ? executionRequest : {};
  const covered = {};
  for (const key of Object.keys(source)) {
    if (key === 'approval_provenance') continue;
    covered[key] = source[key];
  }
  return crypto.createHash('sha256').update(stableStringify(covered)).digest('hex');
}

// The exact string a human signs. Every field that makes this decision THIS decision is in
// it, separated by a character that cannot appear in a hex digest or an ISO timestamp, so
// two different decisions can never produce the same payload.
function buildApprovalPayload({ requestId, decision, decidedBy, executionFingerprint, nonce, issuedAt }) {
  return [
    APPROVAL_PAYLOAD_VERSION,
    requestId,
    decision,
    decidedBy,
    executionFingerprint,
    nonce,
    issuedAt,
  ].join('\n');
}

// Reads the configured verification key. Returns null when unset - callers FAIL CLOSED on
// null rather than proceeding unverified.
//
// REFUSES A PRIVATE KEY. If someone pastes the private half in by mistake, this throws
// instead of quietly working: it would mean the signing key is sitting in the server's
// environment, which defeats the entire mechanism, and a silent success would hide that.
function getConfiguredApprovalPublicKey() {
  const raw = process.env[APPROVAL_PUBLIC_KEY_ENV];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const material = raw.includes('-----BEGIN') ? raw.replace(/\\n/g, '\n') : raw.trim();

  if (material.includes('PRIVATE KEY')) {
    throw new Error(
      `${APPROVAL_PUBLIC_KEY_ENV} contains a PRIVATE key. Only the public half may ever be configured here - ` +
        'the private key must never be stored on, or reachable from, this server.'
    );
  }

  try {
    const key = crypto.createPublicKey(material.includes('-----BEGIN') ? material : `-----BEGIN PUBLIC KEY-----\n${material}\n-----END PUBLIC KEY-----`);
    if (key.asymmetricKeyType !== 'ed25519') {
      throw new Error(`${APPROVAL_PUBLIC_KEY_ENV} must be an Ed25519 public key, got '${key.asymmetricKeyType}'.`);
    }
    return key;
  } catch (err) {
    if (/must be an Ed25519/.test(err.message)) throw err;
    throw new Error(`${APPROVAL_PUBLIC_KEY_ENV} is not a readable public key: ${err.message}`);
  }
}

function getChallengeTtlMs() {
  const parsed = Number(process.env[CHALLENGE_TTL_ENV]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_CHALLENGE_TTL_MS;
}

// Issued challenges, by nonce. In memory and per process, the same deliberate stance
// approvals/approvalWorkflow.js and audit/auditTrail.js already take (no persistence engine
// has been chosen - CLAUDE.md rule 15). A restart invalidates outstanding challenges, which
// fails CLOSED: the human simply requests a new one.
//
// Holding the challenge server-side is what makes replay detectable at all - the nonce is
// consumed on first successful use and can never authorize a second decision.
const ISSUED_CHALLENGES = new Map();

function pruneExpiredChallenges(now) {
  for (const [nonce, challenge] of ISSUED_CHALLENGES) {
    if (challenge.expires_at_ms <= now) ISSUED_CHALLENGES.delete(nonce);
  }
}

// Creates the one-time challenge a human signs for ONE specific pending decision.
//
// The nonce is generated here, with crypto.randomBytes - never supplied by the caller, so a
// caller cannot choose a nonce it has a signature for already.
function issueApprovalChallenge({ request, decision, decidedBy } = {}) {
  if (!request || typeof request !== 'object') {
    throw new Error('issueApprovalChallenge requires the pending approval `request` record.');
  }
  if (decision !== 'approved' && decision !== 'rejected') {
    throw new Error("issueApprovalChallenge requires `decision` to be 'approved' or 'rejected'.");
  }
  if (typeof decidedBy !== 'string' || decidedBy.trim() === '') {
    throw new Error('issueApprovalChallenge requires a non-empty `decidedBy`.');
  }

  const now = Date.now();
  pruneExpiredChallenges(now);

  const nonce = crypto.randomBytes(32).toString('base64url');
  const issuedAt = new Date(now).toISOString();
  const executionFingerprint = computeExecutionFingerprint(request.execution_request);
  const payload = buildApprovalPayload({
    requestId: request.id,
    decision,
    decidedBy: decidedBy.trim(),
    executionFingerprint,
    nonce,
    issuedAt,
  });

  const challenge = {
    nonce,
    request_id: request.id,
    decision,
    decided_by: decidedBy.trim(),
    execution_fingerprint: executionFingerprint,
    issued_at: issuedAt,
    expires_at: new Date(now + getChallengeTtlMs()).toISOString(),
    expires_at_ms: now + getChallengeTtlMs(),
    payload,
    consumed: false,
  };
  ISSUED_CHALLENGES.set(nonce, challenge);

  // The payload is what the human signs; nothing secret is in it, and no key material is
  // returned or recorded anywhere.
  return {
    nonce,
    request_id: challenge.request_id,
    decision: challenge.decision,
    decided_by: challenge.decided_by,
    execution_fingerprint: executionFingerprint,
    issued_at: issuedAt,
    expires_at: challenge.expires_at,
    payload,
    signing_instructions: APPROVAL_SIGNING_INSTRUCTIONS,
  };
}

const APPROVAL_VERIFICATION_CHECKS = [
  'public_key_configured',
  'authorization_supplied',
  'challenge_issued_by_this_server',
  'challenge_not_already_used',
  'challenge_not_expired',
  'challenge_matches_this_decision',
  'payload_matches_challenge',
  'signature_verifies_under_public_key',
];

function refuseVerification(failedCheck, reason) {
  return { verified: false, failed_check: failedCheck, reason, provenance: null };
}

// THE GATE. Decides whether a decision carries genuine human provenance.
//
// Returns { verified, failed_check, reason, provenance } - never throws for an ordinary
// refusal, because a refused approval is a normal outcome, not a programming error.
//
// Every check fails CLOSED: there is no branch that returns verified:true without a
// signature that validated under the configured public key over the exact challenge this
// server issued for this exact request and decision.
//
// A SIGNATURE IS CONSUMED ON SUCCESS. The nonce is marked used before returning, so the
// same signed approval can never authorize a second decision - replay is refused by
// 'challenge_not_already_used' on every subsequent attempt.
function verifyApprovalAuthorization({ request, decision, decidedBy, authorization } = {}) {
  let publicKey;
  try {
    publicKey = getConfiguredApprovalPublicKey();
  } catch (err) {
    return refuseVerification('public_key_configured', err.message);
  }
  if (!publicKey) {
    return refuseVerification(
      'public_key_configured',
      `No ${APPROVAL_PUBLIC_KEY_ENV} is configured, so no human approval can be verified and none is accepted. ` +
        'Approvals fail closed until the verification key is configured.'
    );
  }

  if (!authorization || typeof authorization !== 'object' || Array.isArray(authorization)) {
    return refuseVerification(
      'authorization_supplied',
      'A human approval must carry a signed `authorization` ({ nonce, signature }). A decidedBy string is not authorization.'
    );
  }
  const { nonce, signature } = authorization;
  if (typeof nonce !== 'string' || nonce.trim() === '' || typeof signature !== 'string' || signature.trim() === '') {
    return refuseVerification('authorization_supplied', 'The `authorization` must carry a non-empty `nonce` and `signature`.');
  }

  const challenge = ISSUED_CHALLENGES.get(nonce);
  if (!challenge) {
    // Covers an invented nonce, one from a previous process, and one already pruned.
    return refuseVerification(
      'challenge_issued_by_this_server',
      'No approval challenge with that nonce was issued by this server (or it has expired). Request a new challenge and sign that.'
    );
  }
  if (challenge.consumed) {
    return refuseVerification('challenge_not_already_used', 'That approval challenge has already been used. A signed approval authorizes exactly one decision.');
  }
  if (challenge.expires_at_ms <= Date.now()) {
    ISSUED_CHALLENGES.delete(nonce);
    return refuseVerification('challenge_not_expired', 'That approval challenge has expired. Request a new challenge and sign that.');
  }

  // The challenge is bound to one request, one decision and one approver. A signature
  // obtained for a different decision cannot be redirected at this one.
  if (
    !request ||
    challenge.request_id !== request.id ||
    challenge.decision !== decision ||
    challenge.decided_by !== (typeof decidedBy === 'string' ? decidedBy.trim() : decidedBy)
  ) {
    return refuseVerification(
      'challenge_matches_this_decision',
      'That approval challenge was issued for a different request, decision or approver, so it does not authorize this one.'
    );
  }

  // The action itself must not have changed since the challenge was issued.
  const currentFingerprint = computeExecutionFingerprint(request.execution_request);
  const expectedPayload = buildApprovalPayload({
    requestId: request.id,
    decision,
    decidedBy: challenge.decided_by,
    executionFingerprint: currentFingerprint,
    nonce,
    issuedAt: challenge.issued_at,
  });
  if (expectedPayload !== challenge.payload) {
    return refuseVerification(
      'payload_matches_challenge',
      'The action being approved has changed since this challenge was issued, so the signature no longer covers it. Request a new challenge.'
    );
  }

  let signatureValid = false;
  try {
    signatureValid = crypto.verify(null, Buffer.from(challenge.payload, 'utf8'), publicKey, Buffer.from(signature, 'base64'));
  } catch (err) {
    // A malformed signature is a failed verification, not a server error.
    signatureValid = false;
  }
  if (!signatureValid) {
    return refuseVerification(
      'signature_verifies_under_public_key',
      'The approval signature did not verify under the configured approval public key.'
    );
  }

  challenge.consumed = true;

  return {
    verified: true,
    failed_check: null,
    reason: null,
    // Recorded on the approval record. Carries no key material and no signature secret -
    // the signature itself is kept so a later reader can re-verify, which is only possible
    // with the public key and proves nothing on its own.
    provenance: {
      method: 'ed25519_signature',
      payload_version: APPROVAL_PAYLOAD_VERSION,
      request_id: request.id,
      decision,
      decided_by: challenge.decided_by,
      execution_fingerprint: currentFingerprint,
      nonce,
      issued_at: challenge.issued_at,
      verified_at: new Date().toISOString(),
      signature,
      checks: APPROVAL_VERIFICATION_CHECKS.slice(),
    },
  };
}

// RE-VERIFIES A STORED APPROVAL FROM ITS OWN CONTENTS, immediately before the action it gates.
//
// verifyApprovalAuthorization() above decides whether a decision may be RECORDED. This answers
// a different question, later: is the record now being executed still the one a human signed?
// A durable record could have been edited, planted, or copied between businesses after it was
// written, and a stored `method: 'ed25519_signature'` string proves nothing by itself.
//
// So nothing in the record is taken on trust. The fingerprint is recomputed from the stored
// execution request, the exact signed payload is rebuilt from the stored provenance, and the
// stored signature is verified again under the configured public key. The nonce is NOT
// consumed or looked up - the challenge was already spent when the decision was recorded, and
// this check needs only the public key, so it survives a restart.
//
// `expected` binds the record to the action about to run: the business it is running for, the
// tool being executed and the platform it will touch. Any stated field that disagrees refuses.
//
// Pure apart from reading the configured public key. Never throws for a refusal.
function verifyRecordedProvenance(record, expected = {}) {
  const refuse = (failedCheck, reason) => ({ valid: false, failed_check: failedCheck, reason });
  const isText = (value) => typeof value === 'string' && value.trim() !== '';

  if (!record || typeof record !== 'object' || record.status !== 'approved') {
    return refuse('record_approved', 'The stored record is not an approved approval request.');
  }
  const request = record.execution_request;
  const provenance = request && typeof request === 'object' ? request.approval_provenance : null;
  if (!provenance || typeof provenance !== 'object') {
    return refuse('provenance_present', 'The stored record carries no approval provenance.');
  }
  if (
    provenance.method !== 'ed25519_signature' ||
    provenance.payload_version !== APPROVAL_PAYLOAD_VERSION ||
    !['request_id', 'decision', 'decided_by', 'execution_fingerprint', 'nonce', 'issued_at', 'signature'].every((field) => isText(provenance[field]))
  ) {
    return refuse('provenance_complete', 'The stored approval provenance is incomplete or not an Ed25519 signature record.');
  }
  if (provenance.request_id !== record.id || provenance.decision !== 'approved' || provenance.decided_by !== record.decided_by) {
    return refuse('provenance_matches_record', 'The stored provenance was not produced for this record, this decision and this approver.');
  }

  const fingerprint = computeExecutionFingerprint(request);
  if (fingerprint !== provenance.execution_fingerprint) {
    return refuse('fingerprint_matches_request', 'The stored execution request no longer matches what was signed.');
  }

  let publicKey;
  try {
    publicKey = getConfiguredApprovalPublicKey();
  } catch (err) {
    return refuse('public_key_configured', err.message);
  }
  if (!publicKey) {
    return refuse('public_key_configured', `No ${APPROVAL_PUBLIC_KEY_ENV} is configured, so a stored approval cannot be re-verified and is not trusted.`);
  }

  const payload = buildApprovalPayload({
    requestId: record.id,
    decision: provenance.decision,
    decidedBy: provenance.decided_by,
    executionFingerprint: fingerprint,
    nonce: provenance.nonce,
    issuedAt: provenance.issued_at,
  });
  let signatureValid = false;
  try {
    signatureValid = crypto.verify(null, Buffer.from(payload, 'utf8'), publicKey, Buffer.from(provenance.signature, 'base64'));
  } catch (err) {
    signatureValid = false;
  }
  if (!signatureValid) {
    return refuse('signature_verifies_under_public_key', 'The stored approval signature does not verify under the configured approval public key.');
  }

  // Binding to the action about to run.
  const normalize = (value) => (isText(value) ? value.trim() : null);
  if ('businessId' in expected && normalize(request.business_id) !== normalize(expected.businessId)) {
    return refuse('business_binding', 'The stored approval belongs to a different business than the one this action is running for.');
  }
  if (isText(expected.toolId) && (record.tool_id !== expected.toolId || (isText(request.tool_id) && request.tool_id !== expected.toolId))) {
    return refuse('action_binding', 'The stored approval authorizes a different action than the one being executed.');
  }
  if (isText(expected.platform)) {
    const stated = [
      request.platform,
      request.research_params && typeof request.research_params === 'object' ? request.research_params.platform : null,
      request.autonomy && typeof request.autonomy === 'object' ? request.autonomy.platform : null,
    ].filter(isText);
    if (stated.some((platform) => platform !== expected.platform)) {
      return refuse('platform_binding', 'The stored approval targets a different platform than the one this action will touch.');
    }
  }

  return { valid: true, failed_check: null, reason: null };
}

// Test/operational helper: forgets every outstanding challenge. Exported so a suite can
// isolate itself; it can only ever make verification FAIL (an unknown nonce), never pass.
function clearIssuedApprovalChallenges() {
  ISSUED_CHALLENGES.clear();
}

module.exports = {
  ACTION_CLASSIFICATIONS,
  APPROVAL_POLICY_RULES,
  AUTO_APPROVED_CLASSIFICATIONS,
  getClassificationById,
  requiresApproval,
  // Human approval provenance.
  APPROVAL_PUBLIC_KEY_ENV,
  APPROVAL_PAYLOAD_VERSION,
  APPROVAL_SIGNING_INSTRUCTIONS,
  APPROVAL_VERIFICATION_CHECKS,
  CHALLENGE_TTL_ENV,
  computeExecutionFingerprint,
  buildApprovalPayload,
  getConfiguredApprovalPublicKey,
  issueApprovalChallenge,
  verifyApprovalAuthorization,
  verifyRecordedProvenance,
  clearIssuedApprovalChallenges,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - approval architecture:\n');

  console.log('Action classifications:');
  ACTION_CLASSIFICATIONS.forEach((entry, index) => {
    console.log(`${index + 1}. [${entry.id}] ${entry.title}`);
    console.log(`   ${entry.description}`);
  });

  console.log('\nApproval policy:');
  APPROVAL_POLICY_RULES.forEach((rule, index) => {
    console.log(`${index + 1}. [${rule.id}]`);
    console.log(`   ${rule.description}`);
  });

  console.log('\nNo external service is connected here - externally_executable actions cannot run today.');
}
