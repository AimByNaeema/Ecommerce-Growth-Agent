'use strict';

// FIRST-CLASS VERIFY: after a consequential action, go and look.
//
// WHY IT EXISTS. Until now, "the mutation call returned without throwing" was the whole of
// this project's evidence that something happened. That is not evidence - it is the absence
// of one particular kind of failure. A platform can accept a request and apply it
// differently, partially, or to the wrong record, and an autonomous loop that trusts its own
// return value would carry on as though everything were fine. Verification re-READS the
// platform through the ordinary read path and compares what is actually there against what
// was supposed to be there.
//
// IT NEVER FAKES A PASS. If the platform has no read capability that could observe the
// thing that was changed, the answer is `unverifiable` - a distinct, honest outcome that is
// NOT a success and never counts as one. Etsy, for example, declares four read capabilities
// unsupported; an action whose verification needs one of them cannot be verified here, and
// this module says so rather than inventing a green tick. `unverifiable` is treated as a
// failure by every caller that must decide whether to proceed.
//
// IT VERIFIES, IT DOES NOT REPAIR. Nothing here retries, re-applies, rolls back, or calls a
// write capability. It reads, compares, and reports. The decision about what to do with a
// mismatch belongs to the caller and to the circuit breaker.
//
// RETRIES ARE IDEMPOTENCY-AWARE, AND THAT IS ENFORCED HERE. Every consequential attempt
// carries an idempotency key derived from exactly what it intends to do. A key that has
// already completed successfully is refused - so a crash, a duplicate scheduler tick, or an
// over-eager retry cannot apply the same change twice. This is the same execute-once shape
// approvals/approvalStore.js's claimApprovalForExecution and scheduler/scheduleStore.js's
// claimOccurrence already use.
//
// NO CREDENTIAL IS EVER RECORDED. A verification record holds ids, field names, expected and
// observed values, and a verdict. The store refuses a credential-shaped key outright.

const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');

const { getReadAdapter } = require('../integrations/adapters/adapterRegistry');
const { getDeclaredUnsupportedCapabilities, isUnsupportedCapabilityError } = require('../integrations/adapters/platformAdapterContract');
const { isPlatformEnabledForBusiness } = require('../agent/core/toolPermissions');
const { isValidBusinessId } = require('../configuration/businessRegistry');

const VERIFICATION_VERSION = 1;

// verified     - the platform's own state matches what was expected. The only success.
// mismatch     - the read worked, and what is there is not what was expected.
// not_found    - the entity that was supposed to exist or change could not be found.
// unverifiable - this platform cannot answer the question. NOT a pass.
// failed       - the verification read itself did not complete.
const VERIFICATION_STATUSES = ['verified', 'mismatch', 'not_found', 'unverifiable', 'failed'];

// Which read capability observes the result of which kind of change. Only entries this
// project can genuinely check are listed; an action whose result no read capability can
// observe is unverifiable rather than quietly assumed good.
const VERIFICATION_READ_CAPABILITY = {
  product: 'getProducts',
  collection: 'getCollections',
  inventory_item: 'getInventoryLevels',
  shop: 'getShopInfo',
};

const VERIFIABLE_ENTITY_KINDS = Object.keys(VERIFICATION_READ_CAPABILITY);

const CREDENTIAL_KEY_PATTERN =
  /password|token|secret|api[_-]?key|access[_-]?key|credential|authoriz(a|e)tion|private[_-]?key|ssn|client[_-]?secret/i;

const DEFAULT_BUSINESS_KEY = '_default';

function getDefaultVerificationStoreDir() {
  return process.env.VERIFICATION_STORE_DIR
    ? path.resolve(process.env.VERIFICATION_STORE_DIR)
    : path.join(__dirname, '..', 'memory', 'state', 'verifications');
}

function businessKey(businessId) {
  return businessId === null || businessId === undefined || businessId === '' ? DEFAULT_BUSINESS_KEY : String(businessId);
}

function safeSegment(value) {
  return typeof value === 'string' ? value.replace(/[^a-zA-Z0-9_-]/g, '') : '';
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

// THE IDEMPOTENCY KEY: a fingerprint of exactly what an attempt intends to do.
//
// Derived, never random and never a timestamp, so the SAME intended change computes the
// SAME key on a retry, after a crash, and in a different process - which is the only way a
// duplicate can be recognized as one. A different target, field, or value is a genuinely
// different action and gets its own key.
function computeIdempotencyKey({ businessId = null, platform, action, entityKind, entityId, expected = null } = {}) {
  return crypto
    .createHash('sha256')
    .update(
      stableStringify({
        business_id: businessId === '' ? null : businessId,
        platform,
        action,
        entity_kind: entityKind,
        entity_id: entityId,
        expected,
      })
    )
    .digest('hex');
}

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

function writeJsonAtomically(filePath, value) {
  const directory = path.dirname(filePath);
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tempPath);
    } catch (cleanupErr) {
      // Already gone.
    }
    throw err;
  }
}

function recordFilePath(businessId, idempotencyKey, rootDir) {
  const business = businessKey(businessId);
  if (business !== DEFAULT_BUSINESS_KEY && !isValidBusinessId(business)) return null;
  const safeKey = safeSegment(idempotencyKey);
  if (!safeKey) return null;
  return path.join(rootDir, business, `${safeKey}.json`);
}

// The stored outcome for one idempotency key, or null. Business-scoped: the key alone is
// not enough, the business must match too, so one business can never read or satisfy
// another's completion record.
function getVerificationRecord(idempotencyKey, { businessId = null, rootDir = getDefaultVerificationStoreDir() } = {}) {
  const filePath = recordFilePath(businessId, idempotencyKey, rootDir);
  if (!filePath) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return null;
  }
  if (!parsed || parsed.verification_version !== VERIFICATION_VERSION) return null;
  const expected = businessKey(businessId) === DEFAULT_BUSINESS_KEY ? null : businessKey(businessId);
  if (parsed.business_id !== expected) return null;
  return parsed;
}

// MAY THIS CONSEQUENTIAL ATTEMPT PROCEED?
//
// Refuses an attempt whose idempotency key has already completed successfully. This is the
// duplicate-consequential-action guard: it does not care why the caller is asking again -
// a crash, a re-delivered schedule tick, a manual retry - the answer for an already-applied
// change is always no.
//
// A previous FAILED attempt does not block a retry: retrying something that did not happen
// is legitimate, and the circuit breaker is what stops that becoming a loop.
function checkIdempotency(idempotencyKey, { businessId = null, rootDir = getDefaultVerificationStoreDir() } = {}) {
  const existing = getVerificationRecord(idempotencyKey, { businessId, rootDir });
  if (existing && existing.status === 'verified') {
    return {
      allowed: false,
      reason_code: 'already_completed',
      reason: 'This exact change has already been applied and verified. It is never applied twice.',
      record: existing,
    };
  }
  return { allowed: true, reason_code: null, reason: null, record: existing };
}

// A COMPLETED RECORD IS NEVER DOWNGRADED.
//
// Once an idempotency key has been verified, that fact is permanent. A later verification of
// the same key that comes back mismatched (because the value drifted afterwards, or because
// someone else changed it) does NOT overwrite it - if it did, the duplicate guard would
// silently reopen and the same consequential change could be applied a second time. Drift
// after the fact is a real signal, but it is the caller's and the circuit breaker's to act
// on; it is not permission to re-apply.
//
// Returns { path, stored } so a caller can tell whether its verdict was recorded or whether
// an existing completion stood.
function saveVerificationRecord(record, { rootDir = getDefaultVerificationStoreDir() } = {}) {
  const offending = findCredentialKeyPath(record);
  if (offending) {
    throw new Error(
      `Refusing to persist a verification record: it carries credential-shaped material at '${offending}'.`
    );
  }
  const filePath = recordFilePath(record.business_id, record.idempotency_key, rootDir);
  if (!filePath) throw new Error('Refusing to persist a verification record with an invalid business or key.');

  const existing = getVerificationRecord(record.idempotency_key, { businessId: record.business_id, rootDir });
  if (existing && existing.status === 'verified' && record.status !== 'verified') {
    return { path: filePath, stored: false };
  }

  writeJsonAtomically(filePath, record);
  return { path: filePath, stored: true };
}

// ---------------------------------------------------------------------------------
// Can this even be verified?
// ---------------------------------------------------------------------------------

// Whether this platform can answer the question at all, WITHOUT making a call.
//
// Three independent ways the answer is no, each reported distinctly: the entity kind is one
// nothing here can observe; the platform is not enabled for this business (so it must not
// be read); or the platform's own adapter declares the needed capability unsupported.
function planVerification({ businessId = null, platform, entityKind, enabledPlatforms = null, adapter = null } = {}) {
  const capability = VERIFICATION_READ_CAPABILITY[entityKind] || null;
  if (!capability) {
    return {
      verifiable: false,
      capability: null,
      reason_code: 'entity_kind_not_observable',
      reason: `No read capability in this project observes an entity of kind ${JSON.stringify(entityKind)}, so a change to one cannot be verified.`,
    };
  }

  if (!Array.isArray(enabledPlatforms) || !isPlatformEnabledForBusiness({ platform, enabledPlatforms })) {
    return {
      verifiable: false,
      capability,
      reason_code: 'platform_not_enabled',
      reason: `Platform ${JSON.stringify(platform)} is not enabled for this business, so it is not read - not even to verify.`,
    };
  }

  let resolved = adapter;
  if (!resolved) {
    try {
      resolved = getReadAdapter(platform);
    } catch (err) {
      return {
        verifiable: false,
        capability,
        reason_code: 'no_read_adapter',
        reason: `This project has no conforming read adapter for ${JSON.stringify(platform)}, so nothing on it can be verified.`,
      };
    }
  }

  if (getDeclaredUnsupportedCapabilities(resolved).includes(capability)) {
    return {
      verifiable: false,
      capability,
      reason_code: 'capability_unsupported',
      reason: `This platform's adapter declares '${capability}' unsupported, so a change of this kind cannot be verified here. No verification is fabricated for it.`,
    };
  }

  return { verifiable: true, capability, reason_code: null, reason: null, adapter: resolved };
}

// ---------------------------------------------------------------------------------
// The verification itself
// ---------------------------------------------------------------------------------

function readEntityId(entity) {
  if (!entity || typeof entity !== 'object') return null;
  return entity.id === null || entity.id === undefined ? null : String(entity.id);
}

// Compares one observed entity against the expected field values. Returns the per-field
// findings - every field checked, matching or not, so a reader sees what was actually
// compared rather than only what went wrong.
function compareExpectation(observed, expected) {
  const findings = [];
  let matched = true;
  for (const field of Object.keys(expected).sort()) {
    const expectedValue = expected[field];
    const observedValue = observed && field in observed ? observed[field] : null;
    const fieldMatched = stableStringify(observedValue) === stableStringify(expectedValue);
    if (!fieldMatched) matched = false;
    findings.push({ field, expected: expectedValue, observed: observedValue, matched: fieldMatched });
  }
  return { matched, findings };
}

// Verifies that a consequential action actually produced the expected state.
//
// `expected` is a plain map of field -> value on the target entity. `unexpectedFields` names
// fields that must NOT have changed; each is compared against `baseline` and reported as an
// unintended mutation when it differs - the "no unintended mutation where detectable" check,
// applied only where a baseline genuinely exists, never asserted without one.
//
// `select` (optional) projects the observed entity onto the fields `expected` names, for a
// change whose result is nested rather than a top-level field - one location's quantity on
// an inventory item, or one membership in a product's collections. It only reshapes what
// the platform actually returned; it is not part of the idempotency key, and a projection
// that throws is a failed verification, never a pass.
async function verifyExecution({
  businessId = null,
  platform,
  action,
  entityKind,
  entityId,
  expected = {},
  baseline = null,
  unexpectedFields = [],
  enabledPlatforms = null,
  adapter = null,
  limit = 50,
  now = new Date(),
  rootDir = getDefaultVerificationStoreDir(),
  persist = true,
  select = null,
} = {}) {
  const idempotencyKey = computeIdempotencyKey({ businessId, platform, action, entityKind, entityId, expected });
  const normalizedBusinessId = typeof businessId === 'string' && businessId.trim() !== '' ? businessId.trim() : null;

  const finish = (status, reasonCode, reason, findings = [], unintended = []) => {
    const record = {
      verification_version: VERIFICATION_VERSION,
      idempotency_key: idempotencyKey,
      business_id: normalizedBusinessId,
      platform: typeof platform === 'string' ? platform : null,
      action: typeof action === 'string' ? action : null,
      entity_kind: typeof entityKind === 'string' ? entityKind : null,
      entity_id: entityId === null || entityId === undefined ? null : String(entityId),
      status,
      verified: status === 'verified',
      reason_code: reasonCode,
      reason,
      findings,
      unintended_mutations: unintended,
      verified_at: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    };
    if (persist) {
      try {
        saveVerificationRecord(record, { rootDir });
      } catch (err) {
        // A record that cannot be stored must not turn a real verdict into a crash. The
        // verdict is still returned; the caller's audit trail is the other record of it.
      }
    }
    return record;
  };

  const plan = planVerification({ businessId, platform, entityKind, enabledPlatforms, adapter });
  if (!plan.verifiable) {
    // NOT a pass. An unverifiable action is reported as such, and every caller that must
    // decide whether to proceed treats it as a failure.
    return finish('unverifiable', plan.reason_code, plan.reason);
  }

  let result;
  try {
    result = await plan.adapter[plan.capability]({ businessId, limit });
  } catch (err) {
    if (isUnsupportedCapabilityError(err)) {
      return finish('unverifiable', 'capability_unsupported', `This platform reports '${plan.capability}' unsupported, so the change could not be verified.`);
    }
    // The underlying message is not relayed - it can carry a URL or a third-party detail.
    return finish('failed', 'read_failed', `The verification read ('${plan.capability}') did not complete, so nothing was confirmed.`);
  }

  const observed = entityKind === 'shop'
    ? result
    : (Array.isArray(result) ? result.find((entity) => readEntityId(entity) === String(entityId)) : undefined);

  if (!observed) {
    return finish(
      'not_found',
      'entity_not_found',
      `The target entity ${JSON.stringify(String(entityId))} was not found on the platform after the action, so the action is not confirmed.`
    );
  }

  let comparable = observed;
  if (typeof select === 'function') {
    try {
      comparable = select(observed);
    } catch (err) {
      return finish('failed', 'projection_failed', 'The platform\'s response could not be read in the shape this verification needs, so nothing was confirmed.');
    }
    if (!comparable || typeof comparable !== 'object') {
      return finish('failed', 'projection_failed', 'The platform\'s response could not be read in the shape this verification needs, so nothing was confirmed.');
    }
  }

  const { matched, findings } = compareExpectation(comparable, expected);

  // Unintended mutation, checked only where a baseline genuinely exists to compare against.
  const unintended = [];
  if (baseline && typeof baseline === 'object') {
    for (const field of unexpectedFields.slice().sort()) {
      if (!(field in baseline)) continue;
      const before = baseline[field];
      const after = field in comparable ? comparable[field] : null;
      if (stableStringify(before) !== stableStringify(after)) {
        unintended.push({ field, before, after });
      }
    }
  }

  if (!matched) {
    return finish('mismatch', 'state_mismatch', 'The platform\'s own state does not match what this action was supposed to produce.', findings, unintended);
  }
  if (unintended.length > 0) {
    return finish('mismatch', 'unintended_mutation', 'The intended change is present, but a field that was not supposed to change did.', findings, unintended);
  }
  return finish('verified', null, null, findings, unintended);
}

module.exports = {
  VERIFICATION_VERSION,
  VERIFICATION_STATUSES,
  VERIFICATION_READ_CAPABILITY,
  VERIFIABLE_ENTITY_KINDS,
  getDefaultVerificationStoreDir,
  computeIdempotencyKey,
  findCredentialKeyPath,
  checkIdempotency,
  getVerificationRecord,
  saveVerificationRecord,
  planVerification,
  compareExpectation,
  verifyExecution,
};

if (require.main === module) {
  const os = require('os');
  console.log('Smart E-Commerce Growth AI Agent - first-class verification:\n');

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-demo-'));

  const adapterFor = (products) => ({
    UNSUPPORTED_READ_CAPABILITIES: [],
    isConfigured: () => true,
    getShopInfo: async () => ({ name: 'Demo', domain: 'demo.example', email: null }),
    getProducts: async () => products,
    getOrders: async () => [],
    getCustomers: async () => [],
    getInventoryLevels: async () => [],
    getCollections: async () => [],
  });

  (async () => {
    // Each scenario targets a DIFFERENT entity, because the idempotency key is derived from
    // the intended change - four scenarios against 'p1' would all be the same change.
    const shared = { businessId: 'alpha-co', platform: 'shopify', action: 'shopify_vendor_correction', entityKind: 'product', enabledPlatforms: ['shopify'], rootDir };
    const expected = { brand: 'Correct Vendor' };

    const good = await verifyExecution({ ...shared, entityId: 'p1', expected, adapter: adapterFor([{ id: 'p1', brand: 'Correct Vendor', title: 'Lamp' }]) });
    console.log(`Applied correctly      -> ${good.status}`);

    const bad = await verifyExecution({ ...shared, entityId: 'p2', expected, adapter: adapterFor([{ id: 'p2', brand: 'Something Else', title: 'Lamp' }]) });
    console.log(`Applied wrongly        -> ${bad.status} (${bad.reason_code})`);

    const missing = await verifyExecution({ ...shared, entityId: 'p3', expected, adapter: adapterFor([]) });
    console.log(`Target not there       -> ${missing.status} (${missing.reason_code})`);

    const collateral = await verifyExecution({
      ...shared,
      entityId: 'p4',
      expected,
      baseline: { title: 'Lamp' },
      unexpectedFields: ['title'],
      adapter: adapterFor([{ id: 'p4', brand: 'Correct Vendor', title: 'Renamed by accident' }]),
    });
    console.log(`Collateral change      -> ${collateral.status} (${collateral.reason_code}): ${JSON.stringify(collateral.unintended_mutations)}`);

    const etsyish = await verifyExecution({
      ...shared,
      platform: 'etsy',
      enabledPlatforms: ['etsy'],
      entityKind: 'inventory_item',
      entityId: 'i1',
      expected: { available_total: 5 },
      adapter: { ...adapterFor([]), UNSUPPORTED_READ_CAPABILITIES: ['getInventoryLevels'] },
    });
    console.log(`Platform cannot answer -> ${etsyish.status} (${etsyish.reason_code}) - NOT a pass\n`);

    const key = computeIdempotencyKey({ businessId: 'alpha-co', platform: 'shopify', action: 'shopify_vendor_correction', entityKind: 'product', entityId: 'p1', expected });
    const retry = checkIdempotency(key, { businessId: 'alpha-co', rootDir });
    console.log(`Retrying the change that already succeeded: allowed=${retry.allowed} (${retry.reason_code})`);
    console.log(`Retrying the one that FAILED is still permitted:  allowed=${checkIdempotency(computeIdempotencyKey({ businessId: 'alpha-co', platform: 'shopify', action: 'shopify_vendor_correction', entityKind: 'product', entityId: 'p2', expected }), { businessId: 'alpha-co', rootDir }).allowed}`);
    console.log('\nThe same intended change always computes the same key, so a duplicate is recognizable as one.');
    console.log('A different business computes a different key and can never satisfy another\'s completion.');

    fs.rmSync(rootDir, { recursive: true, force: true });
  })();
}
