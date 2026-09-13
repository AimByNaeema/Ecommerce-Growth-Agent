'use strict';

// THE MISSING EXECUTOR FOR THE THREE SHOPIFY CORRECTIONS.
//
// THE GAP THIS CLOSES. tools/toolRegistry.js has registered shopify_vendor_correction,
// shopify_inventory_correction and shopify_collection_membership_update as 'implemented'
// since they were written, and their real capability - compliance re-check, publish
// authorization, the mutation, and an independent re-read - has existed and been tested in
// integrations/shopify*.js all along. What did not exist was any way to REACH them: they
// have no TOOL_EXECUTORS entry, because each integration function requires the server-held
// approval `requests` array and agent/core/orchestratorExecutionContract.js's executor
// contract passes an executor only (executionRequest, runTokenTracker). So a human could
// approve a correction and nothing would run. This module is the smallest wiring that fixes
// that without widening the executor contract for every other tool.
//
// IT IS ONLY EVER REACHED AFTER A REAL APPROVAL. resumeApprovedExecution() is the single
// path in this codebase that can execute a once-gated action, and it only runs at all when
// a record's status is already 'approved' - which approvals/approvalWorkflow.js can only
// produce through a verified Ed25519 signature. Nothing here approves, signs, verifies, or
// weakens any of that.
//
// ===================================================================================
// THE AUTHORIZATION ARRAY IS BUILT FROM DURABLE STATE, NEVER FROM THE CALLER.
// ===================================================================================
// approvals/publishAuthorization.js deliberately looks the approval record UP from a
// server-held array rather than accepting one, which is what makes a forged record
// impossible - but that guarantee only holds if the ARRAY itself is trustworthy. A caller
// that could hand in [{ id, status: 'approved', decided_by: 'me' }] would defeat it.
//
// So this module never authorizes from a caller-supplied array. It loads the record from
// approvals/approvalStore.js - server-written durable state - re-checks that it is approved
// and carries genuine Ed25519 provenance, and builds a one-element array from THAT. The
// caller's `approvalContext` supplies only non-forgeable locators (which store to read), so
// there is nothing in it to manufacture: pointing it at a different store yields a record
// that either does not exist or does not match, and both are refused.
//
// EXECUTE-ONCE ACROSS RESTARTS. The durable record is CLAIMED before the mutation and
// marked executed after it, using approvalStore's existing claim mechanism - the same guard
// approvals/ already uses. A restart between approval and execution cannot run the
// correction twice, and neither can two callers racing.
//
// NO NEW APPROVAL SYSTEM, NO NEW ORCHESTRATION, NO NEW PLATFORM CALL. Every mutation still
// happens inside the existing integration module, which re-verifies compliance and publish
// authorization for itself before touching Shopify.

const approvalStore = require('../approvals/approvalStore');
const { verifyRecordedProvenance } = require('../approvals/approvalArchitecture');
const executionVerification = require('../reliability/executionVerification');
const { correctProductVendor } = require('./shopifyVendorCorrection');
const { correctInventoryDeficit } = require('./shopifyInventoryCorrection');
const { addProductToFreeDesignsCollection } = require('./shopifyCollectionMembership');

// Every correction here writes to Shopify, so this is the platform each one is verified on and
// bound to. Not a guess: the three integration modules each state PLATFORM 'shopify'.
const CORRECTION_PLATFORM = 'shopify';

// How many entities the shared verification read asks for - the same ceiling the integration
// modules' own re-reads use, so the verification never looks at fewer entities than they did.
const VERIFICATION_READ_LIMIT = 250;

// The three registry ids this module can dispatch, each mapped to the existing integration
// function that already owns the mutation and its gates. Hand-written on purpose, exactly
// like integrations/adapters/adapterRegistry.js's READ_ADAPTERS: a tool reaches this map by
// a deliberate source edit, never dynamically.
const CORRECTION_DISPATCH = {
  shopify_vendor_correction: {
    module: 'integrations/shopifyVendorCorrection.js',
    // Which execution-request parameters this correction genuinely needs. Named here so a
    // missing one is refused with a clear message rather than reaching the integration as
    // undefined - nothing is ever substituted or invented for a missing parameter.
    required_params: ['productId', 'newVendor'],
    // What this correction actually WRITES, described for compliance. See
    // buildCorrectionComplianceInput below for why this lives here and what it may say.
    // The content is the literal value that will be written; the reference is the entity
    // it will be written to. Nothing is summarised, characterised or embellished.
    compliance_content: (params) => ({
      content: String(params.newVendor),
      content_type: 'shopify product vendor field value',
      content_reference: String(params.productId),
    }),
    // WHAT THE SHARED VERIFIER CHECKS AFTERWARDS (reliability/executionVerification.js). The
    // product the vendor was written to must now show exactly that vendor.
    verification_target: (params) => ({
      entity_kind: 'product',
      entity_id: String(params.productId),
      expected: { vendor: params.newVendor },
      select: null,
    }),
    run: (params, common) =>
      correctProductVendor({ ...common, productId: params.productId, newVendor: params.newVendor }),
  },
  shopify_inventory_correction: {
    module: 'integrations/shopifyInventoryCorrection.js',
    required_params: ['inventoryItemId', 'locationId', 'delta', 'idempotencyKey'],
    compliance_content: (params) => ({
      content: `Inventory adjustment of ${params.delta} at location ${params.locationId}.`,
      content_type: 'shopify inventory quantity adjustment',
      content_reference: String(params.inventoryItemId),
    }),
    // The quantity a location should show is only KNOWN when the plan stated the quantity it
    // started from. Without changeFromQuantity there is no honest expected value - the result
    // is reported unverifiable rather than compared against an invented baseline.
    verification_target: (params) => {
      if (!Number.isInteger(params.changeFromQuantity) || !Number.isInteger(params.delta)) {
        return {
          unverifiable: {
            reason_code: 'baseline_unknown',
            reason: 'The approved request states no starting quantity (changeFromQuantity), so the quantity this location should now show is not known and the change cannot be independently verified.',
          },
        };
      }
      const locationId = params.locationId;
      return {
        entity_kind: 'inventory_item',
        entity_id: String(params.inventoryItemId),
        expected: { location_id: locationId, available: params.changeFromQuantity + params.delta },
        // getInventoryLevels nests quantities per location; only the corrected location is read.
        select: (item) => {
          const level = Array.isArray(item.levels) ? item.levels.find((entry) => entry.locationId === locationId) : null;
          return {
            location_id: level ? level.locationId : null,
            available: level && Number.isInteger(level.available) ? level.available : null,
          };
        },
      };
    },
    run: (params, common) =>
      correctInventoryDeficit({
        ...common,
        inventoryItemId: params.inventoryItemId,
        locationId: params.locationId,
        delta: params.delta,
        changeFromQuantity: params.changeFromQuantity === undefined ? null : params.changeFromQuantity,
        idempotencyKey: params.idempotencyKey,
        reason: typeof params.reason === 'string' ? params.reason : 'correction',
      }),
  },
  shopify_collection_membership_update: {
    module: 'integrations/shopifyCollectionMembership.js',
    required_params: ['collectionId', 'productId'],
    compliance_content: (params) => ({
      content: `Add product ${params.productId} to collection ${params.collectionId}.`,
      content_type: 'shopify collection membership change',
      content_reference: String(params.productId),
    }),
    // VERIFIED ON THE PRODUCT, NOT THE COLLECTION. The collection read (getCollections) returns
    // a title, handle and product COUNT - no membership - so it cannot observe this change. The
    // product read returns the product's own collections, which is where membership is visible.
    verification_target: (params) => ({
      entity_kind: 'product',
      entity_id: String(params.productId),
      expected: { collection_membership: params.collectionId },
      select: (product) => ({
        collection_membership:
          Array.isArray(product.collections) && product.collections.some((collection) => collection.id === params.collectionId)
            ? params.collectionId
            : null,
      }),
    }),
    run: (params, common) =>
      addProductToFreeDesignsCollection({ ...common, collectionId: params.collectionId, productId: params.productId }),
  },
};

const CORRECTION_TOOL_IDS = Object.keys(CORRECTION_DISPATCH);

// ---------------------------------------------------------------------------------
// THE COMPLIANCE INPUT A CORRECTION CARRIES INTO ITS APPROVAL
// ---------------------------------------------------------------------------------
//
// WHY THIS EXISTS. approvals/publishAuthorization.js will not authorize a mutation unless
// compliance can be RE-VERIFIED from the request's own content - a recorded verdict is
// worthless on its own (approvals/complianceApprovalGate.js's
// verifyComplianceForApprovalRequest re-runs the engine and refuses any claim that does
// not reproduce). Approvals created on the /orchestrate path carried no compliance input
// at all, so every correction was refused at that check even after a valid human approval:
//
//   "This approval request carries no compliance input, so its compliance verdict cannot
//    be re-verified. A claimed verdict is never accepted on its own."
//
// WHY IT LIVES HERE. This module already owns what each correction IS - its parameters and
// the function that writes them. Describing the same action for compliance belongs beside
// that, not in a second table that could drift from it.
//
// WHAT IT MAY SAY, AND WHAT IT MAY NOT. The content is the literal value the correction
// will write and the reference is the entity it writes to - both taken verbatim from the
// approved execution request. The provenance names this tool as the producing stage and
// cites the execution request itself as the evidence, which is a true statement about
// where the value came from. NOTHING here asserts a verdict, a policy result, a platform
// rule, or any fact about the store: the verdict is computed by the real engine from this
// input, every time, and this function cannot influence it beyond describing the action
// honestly. There is deliberately no branch that could produce a PASS for a particular
// tool.
// The content reference the STORED compliance input was evaluated against, or null when
// the record carries none. Read-only; never substitutes or derives a reference of its own.
function storedComplianceReference(storedRequest) {
  const input = storedRequest && storedRequest.execution_request && storedRequest.execution_request.compliance_input;
  if (!input || typeof input !== 'object') return null;
  return isNonEmptyString(input.content_reference) ? input.content_reference : null;
}

function buildCorrectionComplianceInput(toolId, executionRequest) {
  const entry = CORRECTION_DISPATCH[toolId];
  if (!entry || typeof entry.compliance_content !== 'function') return null;
  const params = (executionRequest && executionRequest.research_params) || {};
  // Every parameter this correction needs must already be present. An incomplete request
  // gets no compliance input, so it is refused at the re-verification check rather than
  // described with gaps filled in.
  const missing = entry.required_params.filter(
    (name) => params[name] === undefined || params[name] === null || params[name] === ''
  );
  if (missing.length > 0) return null;

  const described = entry.compliance_content(params);
  return {
    ...described,
    provenance: {
      source: toolId,
      evidence: [
        {
          signal_kind: 'approved_execution_request',
          reference: `execution request for ${toolId} targeting ${described.content_reference}`,
        },
      ],
    },
    platform_context: { platform: 'shopify' },
  };
}

// Why a dispatch was refused, machine-readable, matching this project's other reason-code
// sets. Every one of these means NO Shopify call was made.
const DISPATCH_REFUSAL_REASONS = [
  'not_a_correction_tool',
  'approval_not_durable',
  'approval_not_approved',
  'approval_provenance_missing',
  'approval_identity_mismatch',
  'approval_provenance_invalid',
  'approval_expired',
  'already_executed',
  'already_completed',
  'missing_parameters',
];

function isCorrectionTool(toolId) {
  return Object.prototype.hasOwnProperty.call(CORRECTION_DISPATCH, toolId);
}

function refuse(reasonCode, reason) {
  return { status: 'error', data: null, error: reason, reason_code: reasonCode, classification: null };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function normalizeBusinessId(businessId) {
  return isNonEmptyString(businessId) ? businessId.trim() : null;
}

function missingParameters(entry, params) {
  return entry.required_params.filter((name) => params[name] === undefined || params[name] === null || params[name] === '');
}

// The idempotency key of one intended entity change, in the shared verification store's own
// format - the same key reliability/executionVerification.js's verifyExecution computes, so a
// check before execution and the record written after it are the same entry.
function correctionIdempotencyKey(toolId, businessId, target) {
  return executionVerification.computeIdempotencyKey({
    businessId: normalizeBusinessId(businessId),
    platform: CORRECTION_PLATFORM,
    action: toolId,
    entityKind: target.entity_kind,
    entityId: target.entity_id,
    expected: target.expected,
  });
}

// HAS THIS EXACT ENTITY CHANGE ALREADY BEEN APPLIED AND VERIFIED - by any approval, on any path?
// Read-only. `applicable: false` means the change has no verifiable target (a missing parameter,
// or an inventory change with no known baseline); those are never reported as duplicates.
function checkCorrectionAlreadyVerified(toolId, executionRequest, { verificationRootDir = undefined } = {}) {
  const entry = CORRECTION_DISPATCH[toolId];
  const notApplicable = { applicable: false, allowed: true, idempotency_key: null, reason_code: null, reason: null };
  if (!entry) return notApplicable;
  const params = (executionRequest && executionRequest.research_params) || {};
  if (missingParameters(entry, params).length > 0) return notApplicable;
  const target = entry.verification_target(params);
  if (!target || target.unverifiable) return notApplicable;
  const businessId = normalizeBusinessId(executionRequest && executionRequest.business_id);
  const idempotencyKey = correctionIdempotencyKey(toolId, businessId, target);
  const check = executionVerification.checkIdempotency(idempotencyKey, { businessId, rootDir: verificationRootDir });
  return { applicable: true, allowed: check.allowed, idempotency_key: idempotencyKey, reason_code: check.reason_code, reason: check.reason };
}

// The shared verifier's verdict on what a correction actually left on the platform.
//
// Runs ONLY when a mutation was attempted. It records 'verified' only when the integration's
// own re-read agreed (outcome.succeeded) AND the independent verifyExecution read agrees; the
// verifier is run with persist:false so its verdict can never be stored as verified on its own
// while the integration disagrees. Every other outcome is recorded as what it is.
async function verifyCorrectionEntity({ toolId, businessId, target, outcome, enabledPlatforms, verificationRootDir, now }) {
  const mutationAttempted = Boolean(outcome && (outcome.succeeded || outcome.status === 'unconfirmed'));
  if (!mutationAttempted) return null;

  if (!target || target.unverifiable) {
    const detail = (target && target.unverifiable) || {
      reason_code: 'no_verification_target',
      reason: 'This correction declares no entity the shared verifier can observe.',
    };
    return { status: 'unverifiable', verified: false, reason_code: detail.reason_code, reason: detail.reason, idempotency_key: null, entity_kind: null, entity_id: null, findings: [] };
  }

  const normalized = normalizeBusinessId(businessId);
  let record;
  if (outcome.succeeded) {
    record = await executionVerification.verifyExecution({
      businessId: normalized,
      platform: CORRECTION_PLATFORM,
      action: toolId,
      entityKind: target.entity_kind,
      entityId: target.entity_id,
      expected: target.expected,
      select: target.select,
      enabledPlatforms,
      limit: VERIFICATION_READ_LIMIT,
      now,
      rootDir: verificationRootDir,
      persist: false,
    });
  } else {
    // The mutation was accepted but the integration's own re-read did not confirm it. The two
    // reads cannot agree, so this is never verified - recorded as a failure under the same key.
    record = {
      verification_version: executionVerification.VERIFICATION_VERSION,
      idempotency_key: correctionIdempotencyKey(toolId, normalized, target),
      business_id: normalized,
      platform: CORRECTION_PLATFORM,
      action: toolId,
      entity_kind: target.entity_kind,
      entity_id: target.entity_id,
      status: 'failed',
      verified: false,
      reason_code: 'integration_reread_unconfirmed',
      reason: "The platform accepted the change, but the integration's own re-read did not confirm it, so it is not verified.",
      findings: [],
      unintended_mutations: [],
      verified_at: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    };
  }

  try {
    executionVerification.saveVerificationRecord(record, { rootDir: verificationRootDir });
  } catch (err) {
    // The verdict is still returned and audited; a store failure never invents success.
  }

  return {
    status: record.status,
    verified: record.status === 'verified',
    reason_code: record.reason_code,
    reason: record.reason,
    idempotency_key: record.idempotency_key,
    entity_kind: record.entity_kind,
    entity_id: record.entity_id,
    findings: record.findings,
  };
}

// Executes one approved correction.
//
// `decidedApprovalRequest` is used ONLY for its id, tool and business - never as evidence
// that a decision happened. That evidence comes from the durable record loaded below.
async function executeApprovedCorrection(
  decidedApprovalRequest,
  { storeDir = undefined, auditTracker = null, now = new Date(), enabledPlatforms = null, verificationRootDir = undefined } = {}
) {
  const toolId = decidedApprovalRequest && decidedApprovalRequest.tool_id;
  const entry = CORRECTION_DISPATCH[toolId];
  if (!entry) {
    return refuse('not_a_correction_tool', `'${toolId}' is not one of this project's approved-correction capabilities.`);
  }

  const requestId = decidedApprovalRequest.id;
  const executionRequest = decidedApprovalRequest.execution_request || {};
  const businessId = executionRequest.business_id === undefined ? null : executionRequest.business_id;
  const storeOptions = storeDir ? { storeDir } : {};

  // --- The durable record is the only authorization evidence accepted --------------
  const envelope = approvalStore.loadApprovalRecord(requestId, { expectedBusinessId: businessId, ...storeOptions });
  if (!envelope || !envelope.approval_request) {
    return refuse(
      'approval_not_durable',
      `Approval '${requestId}' is not in durable approval state for this business, so nothing was executed. A correction is authorized by stored, server-written state - never by a record handed to the executor.`
    );
  }

  const stored = envelope.approval_request;
  if (stored.status !== 'approved') {
    return refuse('approval_not_approved', `Approval '${requestId}' is '${stored.status}' in durable state, not approved. Nothing was executed.`);
  }
  const provenance = stored.execution_request && stored.execution_request.approval_provenance;
  if (!provenance || provenance.method !== 'ed25519_signature') {
    return refuse(
      'approval_provenance_missing',
      `Approval '${requestId}' carries no Ed25519 human-approval provenance in durable state, so it is not treated as approved. Nothing was executed.`
    );
  }
  // The record the caller is acting on must BE the stored one. A caller naming a real
  // approval id while passing a different tool or business is refused here.
  if (
    stored.id !== requestId ||
    stored.tool_id !== toolId ||
    normalizeBusinessId(stored.execution_request && stored.execution_request.business_id) !== normalizeBusinessId(businessId)
  ) {
    return refuse('approval_identity_mismatch', `Approval '${requestId}' does not match the action being executed. Nothing was executed.`);
  }

  // --- The stored proof is re-verified NOW, immediately before any mutation ----------
  // A `method` string in a file proves nothing. The signature is checked again, from the
  // stored record alone, against the configured public key - and bound to this business,
  // this tool and this platform.
  const proof = verifyRecordedProvenance(stored, { businessId, toolId, platform: CORRECTION_PLATFORM });
  if (!proof.valid) {
    return refuse(
      'approval_provenance_invalid',
      `Approval '${requestId}' failed re-verification of its stored proof (${proof.failed_check}): ${proof.reason} Nothing was executed.`
    );
  }

  const params = (stored.execution_request && stored.execution_request.research_params) || {};
  const missing = missingParameters(entry, params);

  // --- The same entity change is never applied twice, through any approval ----------
  // Checked BEFORE the claim, so a duplicate consumes nothing and writes nothing.
  const target = missing.length === 0 ? entry.verification_target(params) : null;
  if (target && !target.unverifiable) {
    const key = correctionIdempotencyKey(toolId, businessId, target);
    const check = executionVerification.checkIdempotency(key, { businessId: normalizeBusinessId(businessId), rootDir: verificationRootDir });
    if (!check.allowed) {
      return refuse('already_completed', `This exact change has already been applied and verified. Approval '${requestId}' was not executed.`);
    }
  }

  // --- Execute-once, across restarts and across concurrent callers -----------------
  const claim = approvalStore.claimApprovalForExecution(requestId, { expectedBusinessId: businessId, now, ...storeOptions });
  if (!claim.ok) {
    const reasonCode = claim.reason === 'already_executed' ? 'already_executed' : claim.reason === 'expired' ? 'approval_expired' : 'approval_not_durable';
    return refuse(
      reasonCode,
      `Approval '${requestId}' could not be claimed for execution (${claim.reason}): ${claim.message} Nothing was executed.`
    );
  }

  // --- Parameters come from the approved execution request, never from anywhere else -
  // They are part of what the human signed: agent/core/autonomyPolicy.js's execution
  // fingerprint covers the whole execution request, so changing a parameter after approval
  // invalidates the signature rather than quietly executing something else.
  if (missing.length > 0) {
    return refuse(
      'missing_parameters',
      `The approved request for '${toolId}' does not state ${missing.join(', ')}. Nothing was executed, and no value was substituted.`
    );
  }

  // THE ARRAY IS BUILT FROM DURABLE STATE. publishAuthorization looks the record up from
  // this array; giving it the stored record is what makes the lookup meaningful.
  const requests = [stored];

  const outcome = await entry.run(params, {
    requests,
    requestId,
    // THE CONTENT REFERENCE MUST BE THE ONE COMPLIANCE WAS EVALUATED AGAINST.
    // approvals/publishAuthorization.js reads the reference out of the stored compliance
    // input and refuses when the caller names a different one - that mismatch check is
    // what stops an approval for one entity authorizing a write to another. So the stored
    // input's own reference is used when there is one, and the request id remains the
    // fallback for a record that carries no compliance input (unchanged behaviour).
    contentReference: isNonEmptyString(params.contentReference)
      ? params.contentReference
      : storedComplianceReference(stored) || requestId,
    specialistId: stored.specialist_id || 'product',
    businessId,
    auditTracker,
  });

  const succeeded = Boolean(outcome && outcome.succeeded);

  // INDEPENDENT ENTITY VERIFICATION, through the shared verifier.
  const entityVerification = await verifyCorrectionEntity({
    toolId,
    businessId,
    target,
    outcome,
    enabledPlatforms,
    verificationRootDir,
    now,
  });
  if (succeeded) {
    // Only a genuine success marks the durable record executed. A refusal or failure leaves
    // it claimed-but-not-executed, which is the honest state and does not silently permit a
    // second attempt to be treated as a first.
    try {
      approvalStore.saveApprovalRecord(stored, { ...storeOptions, executionState: 'executed' });
    } catch (err) {
      // The mutation already happened; failing to record that must not be reported as a
      // failed correction. The audit trail and the integration's own result carry it too.
    }
  }

  return {
    status: succeeded ? 'success' : 'error',
    data: succeeded ? outcome : null,
    error: succeeded ? null : (outcome && outcome.reason) || 'The correction did not succeed.',
    reason_code: null,
    classification: stored.classification || null,
    correction_status: (outcome && outcome.status) || null,
    entity_verification: entityVerification,
  };
}

module.exports = {
  CORRECTION_DISPATCH,
  CORRECTION_TOOL_IDS,
  CORRECTION_PLATFORM,
  DISPATCH_REFUSAL_REASONS,
  isCorrectionTool,
  buildCorrectionComplianceInput,
  checkCorrectionAlreadyVerified,
  executeApprovedCorrection,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - approved correction dispatch:\n');
  console.log(`Dispatchable after a verified human approval: ${CORRECTION_TOOL_IDS.join(', ')}\n`);
  for (const [toolId, entry] of Object.entries(CORRECTION_DISPATCH)) {
    console.log(`[${toolId}]`);
    console.log(`  integration:     ${entry.module}`);
    console.log(`  required params: ${entry.required_params.join(', ')}`);
  }
  console.log('\nEvery dispatch loads its authorization from durable approval state, never from its caller.');
  console.log('A record that is not stored, not approved, or carries no Ed25519 provenance is refused,');
  console.log('and a claimed approval can never be executed a second time.');
}
