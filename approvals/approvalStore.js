'use strict';

// Durable storage for pending approvals and the pending ACTION each one gates, so a
// paused, awaiting-human decision survives a restart or a deploy.
//
// WHY THIS EXISTS. approvals/approvalWorkflow.js is deliberately a set of pure functions
// over a caller-held array, and server.js held that array in an in-memory Map. That was
// honest for a single-process dashboard, but it means a restart silently discards every
// outstanding approval AND the execution context needed to carry it out - the human's
// decision point simply vanishes, and the gated action is lost with it. Nothing about the
// approval gate was wrong; it just had nowhere durable to live.
//
// REUSES THE PROJECT'S EXISTING PERSISTENCE PATTERN, adds no dependency and no database:
// one JSON file per approval under memory/state/approvals/, an env-overridable directory
// read at call time, a filename-safe id, and a corrupt single file that can never take down
// reading the rest - exactly the shape agent/core/runHistoryStore.js established and
// agent/core/memoryStore.js followed.
//
// ONE THING IS DELIBERATELY STRICTER THAN EITHER OF THOSE: writes are ATOMIC. Both existing
// stores call fs.writeFileSync directly, which can leave a half-written file if the process
// dies mid-write - for a run-history record that is a lost log line, but for an approval it
// would be a gated action in an unreadable state, and "unreadable" must never be resolvable
// by guessing. Every write here goes to a temp file in the same directory and is then
// renamed over the target, which is atomic on a single filesystem: a reader sees either the
// complete previous file or the complete new one, never a partial one.
//
// THE APPROVAL RECORD IS STORED VERBATIM, AND THAT IS LOAD-BEARING. approvals/
// approvalArchitecture.js fingerprints the execution request to bind a human signature to
// one exact action, so the record must round-trip byte-for-byte or the signature stops
// verifying. That is why nothing here rewrites, normalizes, prunes or redacts the record -
// and why a record carrying credential-shaped material is REFUSED outright (see
// assertNoCredentialMaterial) rather than quietly redacted: redaction would silently
// invalidate the very provenance this phase exists to protect.
//
// WHAT IS AND IS NOT KEPT. The verified provenance IS kept, signature included: it is the
// audit evidence, it is re-verifiable with the public key alone, and it proves nothing to
// anyone who obtains it (a signature over an already-decided action authorizes nothing else
// - the nonce is single-use). No credential, token, private key or API key is ever written:
// that is enforced, not merely intended.

const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');

// Bumped only when the envelope shape changes in a way a reader must notice. An envelope
// written by a newer version is refused rather than half-understood.
const APPROVAL_ENVELOPE_VERSION = 1;

// The lifecycle of the ACTION, tracked on the envelope rather than on the approval record.
//
// approvals/approvalRequestModel.js's own statuses are exactly pending/approved/rejected and
// describe the DECISION. Whether the approved action has since been carried out is a
// different question, and widening that model would change a shape approvals/
// publishAuthorization.js and the model validator both depend on. So the execution lifecycle
// lives here, beside the durable state it belongs to.
const EXECUTION_STATES = ['awaiting_decision', 'decided', 'executed', 'cancelled'];

// Mirrors audit/auditTrail.js's own redaction pattern. Used here to REFUSE, not to redact -
// see this file's header.
const CREDENTIAL_KEY_PATTERN =
  /password|token|secret|api[_-]?key|access[_-]?key|credential|authoriz(a|e)tion|private[_-]?key|ssn|client[_-]?secret/i;

// Read at call time, never memoized, so a test can point it at a temp directory before its
// first write - the same convention agent/core/runHistoryStore.js uses.
function getDefaultApprovalStoreDir() {
  return process.env.APPROVAL_STORE_DIR
    ? path.resolve(process.env.APPROVAL_STORE_DIR)
    : path.join(__dirname, '..', 'memory', 'state', 'approvals');
}

// An approval id is caller-supplied (approvals/approvalWorkflow.js requires it and never
// generates one), so it reaches the filesystem and must be sanitized: anything outside the
// safe set is stripped, which makes '../escape' unable to address anything outside storeDir.
function safeApprovalId(id) {
  return typeof id === 'string' ? id.replace(/[^a-zA-Z0-9_-]/g, '') : '';
}

function approvalFilePath(storeDir, id) {
  return path.join(storeDir, `${safeApprovalId(id)}.json`);
}

function ensureStoreDir(storeDir) {
  fs.mkdirSync(storeDir, { recursive: true });
}

// Depth-first scan for a credential-shaped KEY anywhere in the record. Returns the offending
// key path, or null when the record is clean.
//
// Checks keys rather than values on purpose: a value cannot be recognized as a secret
// reliably, but this project's own convention is that anything credential-bearing is NAMED
// as such (SHOPIFY_ADMIN_API_ACCESS_TOKEN, ETSY_OAUTH_ACCESS_TOKEN, ANTHROPIC_API_KEY), and
// audit/auditTrail.js already redacts on exactly that basis.
//
// `approval_provenance.signature` is explicitly allowed: it is the verification/audit
// evidence this phase exists to preserve, it is not a credential, and it grants nothing.
function findCredentialKeyPath(value, trail = []) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findCredentialKeyPath(value[index], trail.concat(`[${index}]`));
      if (found) return found;
    }
    return null;
  }
  for (const key of Object.keys(value)) {
    const here = trail.concat(key);
    if (CREDENTIAL_KEY_PATTERN.test(key)) return here.join('.');
    const found = findCredentialKeyPath(value[key], here);
    if (found) return found;
  }
  return null;
}

// FAILS CLOSED ON CREDENTIAL MATERIAL. Throws rather than writing, and rather than
// redacting: a redacted execution request would no longer match the fingerprint the human
// signed, so the approval would silently stop being verifiable. Refusing surfaces the
// problem where it can actually be fixed - at whatever put a credential into an execution
// request in the first place.
function assertNoCredentialMaterial(envelope) {
  const offending = findCredentialKeyPath(envelope);
  if (offending) {
    throw new Error(
      `Refusing to persist approval state: it carries credential-shaped material at '${offending}'. ` +
        'Approval state is never allowed to contain credentials, tokens or keys, and it is refused rather ' +
        'than redacted because redaction would invalidate the signed execution fingerprint.'
    );
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ATOMIC WRITE: same-directory temp file, then rename over the target. Rename is atomic
// within one filesystem, so a concurrent or post-crash reader sees a complete file - either
// the old one or the new one - and never a truncated one. The temp file is removed on
// failure so a crashed write leaves no debris.
function writeJsonAtomically(filePath, value) {
  const directory = path.dirname(filePath);
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tempPath);
    } catch (cleanupErr) {
      // The temp file never existed or is already gone - nothing to report, and the real
      // error below is the one that matters.
    }
    throw err;
  }
}

// The business a stored approval belongs to. Read from the execution request, which is where
// agent/core/orchestratorExecutionContract.js's createExecutionRequest already puts it and
// where approvals/approvalWorkflow.js's own expectedBusinessId guard already looks - never a
// second, separately-maintained copy that could disagree with it.
function businessIdOf(record) {
  const executionRequest = record && record.execution_request;
  const value = isPlainObject(executionRequest) ? executionRequest.business_id : null;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

// The platform a stored approval targets, when the execution request names one. Optional by
// design: most approvals are platform-neutral, and inventing a platform for them would be
// exactly the kind of guess this project forbids.
function platformOf(record) {
  const executionRequest = record && record.execution_request;
  if (!isPlainObject(executionRequest)) return null;
  const candidates = [executionRequest.platform, isPlainObject(executionRequest.research_params) ? executionRequest.research_params.platform : null];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return null;
}

// Persists one approval and the action it gates.
//
//   record       - the REAL approvals/approvalRequestModel.js record, stored verbatim.
//   executionState - where the ACTION stands (see EXECUTION_STATES). Defaults from the
//                  record's own decision status, so a caller that just records a decision
//                  does not have to restate it.
//   expiresAt    - optional ISO timestamp after which the action may no longer execute.
//                  Null (the default) means no expiry is asserted - this module does not
//                  invent a staleness policy it was never given.
function saveApprovalRecord(record, { executionState = null, expiresAt = null, storeDir = getDefaultApprovalStoreDir() } = {}) {
  if (!isPlainObject(record)) {
    throw new Error('saveApprovalRecord requires an approval request record object.');
  }
  const id = safeApprovalId(record.id);
  if (!id) {
    throw new Error('saveApprovalRecord requires a non-empty, filename-safe approval id.');
  }

  const resolvedState = executionState || (record.status === 'pending' ? 'awaiting_decision' : 'decided');
  if (!EXECUTION_STATES.includes(resolvedState)) {
    throw new Error(`saveApprovalRecord requires executionState to be one of: ${EXECUTION_STATES.join(', ')}`);
  }

  const existing = readEnvelope(approvalFilePath(storeDir, id));

  const envelope = {
    envelope_version: APPROVAL_ENVELOPE_VERSION,
    approval_id: record.id,
    business_id: businessIdOf(record),
    platform: platformOf(record),
    execution_state: resolvedState,
    // Preserved across re-saves so a record's first-seen time is never rewritten by a later
    // decision, the same discipline server.js's saveWorkflowRunRecord already applies to
    // created_at.
    stored_at: (existing && existing.stored_at) || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    executed_at: (existing && existing.executed_at) || null,
    expires_at: expiresAt || (existing ? existing.expires_at : null) || null,
    // Verbatim. See this file's header on why nothing here rewrites it.
    approval_request: record,
  };

  assertNoCredentialMaterial(envelope);
  ensureStoreDir(storeDir);
  writeJsonAtomically(approvalFilePath(storeDir, id), envelope);
  return envelope;
}

// Reads one envelope file. Returns null for missing, unreadable, corrupt, or
// wrong-shaped content - a corrupt approval is INDISTINGUISHABLE from a missing one to every
// caller, which is what makes corruption fail closed: nothing downstream can execute an
// action it could not read.
function readEnvelope(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  if (parsed.envelope_version !== APPROVAL_ENVELOPE_VERSION) return null;
  if (!isPlainObject(parsed.approval_request)) return null;
  if (!EXECUTION_STATES.includes(parsed.execution_state)) return null;
  return parsed;
}

// Loads one stored approval.
//
// CROSS-BUSINESS ISOLATION: when expectedBusinessId is supplied, an envelope belonging to a
// different business returns null - identical to "not found", so a caller cannot use this to
// discover that another business's approval exists. Omitting it preserves the behaviour of a
// single-business caller, exactly as decideApprovalRequest's own expectedBusinessId does.
function loadApprovalRecord(approvalId, { expectedBusinessId = null, storeDir = getDefaultApprovalStoreDir() } = {}) {
  const id = safeApprovalId(approvalId);
  if (!id) return null;
  const envelope = readEnvelope(approvalFilePath(storeDir, id));
  if (!envelope) return null;
  if (expectedBusinessId && envelope.business_id !== expectedBusinessId) return null;
  return envelope;
}

// Every stored approval still awaiting a human decision, newest first. One corrupt file is
// skipped rather than failing the whole listing - the same "one file per unit" resilience
// agent/core/runHistoryStore.js documents.
function listPendingApprovals({ businessId = null, storeDir = getDefaultApprovalStoreDir() } = {}) {
  let fileNames;
  try {
    fileNames = fs.readdirSync(storeDir).filter((name) => name.endsWith('.json'));
  } catch (err) {
    return [];
  }

  const pending = [];
  for (const fileName of fileNames) {
    const envelope = readEnvelope(path.join(storeDir, fileName));
    if (!envelope) continue;
    if (envelope.execution_state !== 'awaiting_decision') continue;
    if (envelope.approval_request.status !== 'pending') continue;
    if (businessId && envelope.business_id !== businessId) continue;
    pending.push(envelope);
  }
  return pending.sort((a, b) => String(b.stored_at).localeCompare(String(a.stored_at)));
}

const CLAIM_REFUSAL_REASONS = {
  not_found: 'No stored approval with that id is readable for this business.',
  not_approved: 'That approval was not approved, so the action it gates may not execute.',
  already_executed: 'That action has already been executed. A stored approval authorizes exactly one execution.',
  cancelled: 'That action was cancelled and may not execute.',
  expired: 'That action has expired and may not execute.',
  still_awaiting_decision: 'That approval is still awaiting a human decision.',
};

// THE EXECUTE-ONCE GATE. Claims a stored, approved action for execution, or refuses.
//
// Every refusal in requirement order - unreadable, not approved, still undecided, cancelled,
// expired, already executed - returns { ok: false, reason } and changes nothing. A successful
// claim marks the envelope 'executed' and writes it BEFORE returning, so a crash after the
// claim leaves the action unrepeatable rather than repeatable: the failure mode is a missed
// execution a human can retry deliberately, never a duplicate one nobody asked for.
//
// This is the durable counterpart to the single-use nonce in approvals/approvalArchitecture.js:
// that stops one signature authorizing two decisions, this stops one decision authorizing two
// executions across a restart.
function claimApprovalForExecution(approvalId, { expectedBusinessId = null, now = new Date(), storeDir = getDefaultApprovalStoreDir() } = {}) {
  const envelope = loadApprovalRecord(approvalId, { expectedBusinessId, storeDir });
  if (!envelope) return { ok: false, reason: 'not_found', message: CLAIM_REFUSAL_REASONS.not_found, envelope: null };

  if (envelope.execution_state === 'executed') {
    return { ok: false, reason: 'already_executed', message: CLAIM_REFUSAL_REASONS.already_executed, envelope };
  }
  if (envelope.execution_state === 'cancelled') {
    return { ok: false, reason: 'cancelled', message: CLAIM_REFUSAL_REASONS.cancelled, envelope };
  }
  if (envelope.execution_state === 'awaiting_decision') {
    return { ok: false, reason: 'still_awaiting_decision', message: CLAIM_REFUSAL_REASONS.still_awaiting_decision, envelope };
  }
  if (envelope.approval_request.status !== 'approved') {
    return { ok: false, reason: 'not_approved', message: CLAIM_REFUSAL_REASONS.not_approved, envelope };
  }
  if (envelope.expires_at && new Date(envelope.expires_at).getTime() <= now.getTime()) {
    return { ok: false, reason: 'expired', message: CLAIM_REFUSAL_REASONS.expired, envelope };
  }

  const claimed = { ...envelope, execution_state: 'executed', executed_at: now.toISOString(), updated_at: now.toISOString() };
  ensureStoreDir(storeDir);
  writeJsonAtomically(approvalFilePath(storeDir, safeApprovalId(approvalId)), claimed);
  return { ok: true, reason: null, message: null, envelope: claimed };
}

// Marks a stored action cancelled so it can never be claimed. Returns null when there is
// nothing readable to cancel (or it belongs to another business) - cancelling is not a way to
// discover that an approval exists.
function cancelStoredApproval(approvalId, { expectedBusinessId = null, storeDir = getDefaultApprovalStoreDir() } = {}) {
  const envelope = loadApprovalRecord(approvalId, { expectedBusinessId, storeDir });
  if (!envelope) return null;
  if (envelope.execution_state === 'executed') return envelope;
  const cancelled = { ...envelope, execution_state: 'cancelled', updated_at: new Date().toISOString() };
  ensureStoreDir(storeDir);
  writeJsonAtomically(approvalFilePath(storeDir, safeApprovalId(approvalId)), cancelled);
  return cancelled;
}

module.exports = {
  APPROVAL_ENVELOPE_VERSION,
  EXECUTION_STATES,
  CLAIM_REFUSAL_REASONS,
  getDefaultApprovalStoreDir,
  safeApprovalId,
  findCredentialKeyPath,
  saveApprovalRecord,
  loadApprovalRecord,
  listPendingApprovals,
  claimApprovalForExecution,
  cancelStoredApproval,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - durable approval store:\n');
  console.log(`Store directory: ${getDefaultApprovalStoreDir()}`);
  console.log(`Envelope version: ${APPROVAL_ENVELOPE_VERSION}`);
  console.log(`Execution states: ${EXECUTION_STATES.join(' -> ')}`);
  console.log('\nEvery write is atomic (temp file + rename), so a crash mid-write can never leave a');
  console.log('half-written approval. A corrupt file reads back as "not found", so nothing executes.');
  console.log('\nNo credential, token or key is ever persisted - a record carrying one is REFUSED');
  console.log('rather than redacted, because redaction would invalidate the signed execution fingerprint.');
}
