'use strict';

// Tests for the Etsy integration and its publishing workflow:
//
//   Content -> Compliance -> Human Approval -> Publish Authorization -> Etsy Publish
//
// The security property under test is a CALL COUNT. Almost every test below drives the
// workflow with something that must not be allowed to publish and then asserts that the
// adapter was called EXACTLY ZERO times - not that a call was made and its result
// discarded. The one authorized path asserts exactly one call, with the listing that was
// actually approved.
//
// NO REAL ETSY CALL, AND NO NETWORK CALL OF ANY KIND, IS MADE ANYWHERE IN THIS FILE. The
// adapter's publishListing is replaced on its shared module object for every test that
// reaches it (this project's existing no-framework mocking convention), and the real
// adapter cannot reach the network either - it throws before any transport, which is
// itself asserted below. global.fetch is additionally asserted untouched.
//
// Every brand, phrase, identity, credential and reference below is an invented
// placeholder. No real credential is read, written, or needed to run this file.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const etsyClient = require('../../integrations/adapters/etsyClient');
const { MARKETPLACE, publishAuthorizedListingToEtsy } = require('../../integrations/etsyPublishing');
const {
  requestApprovalForCheckedContent,
  decideComplianceGatedApproval,
} = require('../../approvals/complianceApprovalGate');
const { createApprovalRequest, decideApprovalRequest } = require('../../approvals/approvalWorkflow');
const {
  PUBLISHING_ADAPTER_CAPABILITIES,
  PUBLISHING_CONTRACT_RULES,
  validatePublishingAdapterShape,
  validateAdapterShape,
  getPublishingCapabilityById,
} = require('../../integrations/adapters/platformAdapterContract');
const { CREDENTIAL_KEYS } = require('../../configuration/businessRegistry');
const { createAuditTracker, getEventsByType } = require('../../audit/auditTrail');

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

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(`  ${err.message}`);
    failed += 1;
  }
}

const CONTENT_REFERENCE = '(placeholder) handmade-jacket-listing';
const OTHER_CONTENT_REFERENCE = '(placeholder) a-completely-different-listing';

const PROVENANCE = {
  source: 'listing_content_generation',
  evidence: [{ signal_kind: 'competitor_faq', reference: '(placeholder FAQ reference)' }],
};

const PASSING_CONTENT = 'A warm, water-resistant jacket made for cold, wet commutes.';
const REVIEW_CONTENT = 'This jacket lasts [VERIFY: typical lifespan] with normal use and care.';
const BLOCKED_CONTENT = 'Every design in our shop is guaranteed copyright-free, so use it however you like.';

const LISTING = {
  marketplace: 'etsy',
  product_reference: '(placeholder product)',
  formatted_title: '(placeholder title)',
  formatted_description: '(placeholder description)',
  formatted_attributes: [],
  format_constraints_applied: [],
};

function complianceInput(content, contentReference = CONTENT_REFERENCE) {
  return { content, content_reference: contentReference, content_type: 'marketplace listing', provenance: PROVENANCE };
}

// The real pipeline end to end, returning the SERVER-HELD requests array.
function pipeline(content = PASSING_CONTENT, { decision = 'approved', contentReference = CONTENT_REFERENCE } = {}) {
  const gated = requestApprovalForCheckedContent({
    id: 'apr-1',
    toolId: 'compliance_check',
    complianceInput: complianceInput(content, contentReference),
  });
  if (gated.status !== 'pending_approval') return gated.requests;
  if (decision === 'pending') return gated.requests;
  return decideComplianceGatedApproval(gated.requests, 'apr-1', {
    decision,
    decidedBy: 'shop-owner@example.com (placeholder)',
  }).requests;
}

// Replaces the adapter's transport and counts every call. No configuration can reach a
// real Etsy endpoint, and global.fetch is asserted untouched throughout.
async function withMockedEtsy({ result = { listing_id: 1234567890, state: 'active' }, throws = null }, fn) {
  const savedPublish = etsyClient.publishListing;
  const savedFetch = global.fetch;
  const calls = [];
  etsyClient.publishListing = async (request) => {
    calls.push(request);
    if (throws) throw new Error(throws);
    return result;
  };
  try {
    return await fn(calls, () => assert.strictEqual(global.fetch, savedFetch, 'global.fetch must never be touched'));
  } finally {
    etsyClient.publishListing = savedPublish;
    global.fetch = savedFetch;
  }
}

function publish(requests, overrides = {}) {
  return publishAuthorizedListingToEtsy({
    requests,
    requestId: 'apr-1',
    contentReference: CONTENT_REFERENCE,
    listing: LISTING,
    ...overrides,
  });
}

(async () => {
  // --- The adapter contract --------------------------------------------------------

  test('the Etsy adapter satisfies the publishing adapter contract', () => {
    const validation = validatePublishingAdapterShape(etsyClient);
    assert.strictEqual(validation.valid, true, validation.errors.join('; '));
    for (const capability of PUBLISHING_ADAPTER_CAPABILITIES) {
      assert.strictEqual(typeof etsyClient[capability.id], 'function');
      assert.ok(getPublishingCapabilityById(capability.id));
    }
    assert.ok(PUBLISHING_CONTRACT_RULES.some((rule) => rule.id === 'authorization_before_mutation'));
    assert.ok(PUBLISHING_CONTRACT_RULES.some((rule) => rule.id === 'never_fabricate_a_publish_result'));
  });

  test('the publishing contract is ADDITIVE - the read contract is unchanged', () => {
    // Shopify is a read adapter and must still validate against the read contract, which
    // this change did not touch.
    const shopifyClient = require('../../integrations/adapters/shopifyClient');
    assert.strictEqual(validateAdapterShape(shopifyClient).valid, true);
    // A read-only adapter is NOT publish-capable, and the two checks answer differently.
    assert.strictEqual(validatePublishingAdapterShape(shopifyClient).valid, false);
    // And the Etsy adapter deliberately does not claim the read contract it does not
    // implement - it is a publishing adapter only.
    assert.strictEqual(validateAdapterShape(etsyClient).valid, false);
  });

  test('NO SECOND INTEGRATION FRAMEWORK: the adapter reuses the existing shared layers', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'integrations', 'adapters', 'etsyClient.js'), 'utf8');
    assert.ok(source.includes("require('../../agent/core/networkRetry')"), 'must reuse the shared retry/timeout layer');
    assert.ok(source.includes("require('../../configuration/businessRegistry')"), 'must reuse per-business credentials');
    assert.ok(source.includes("require('./shopifyClient')"), 'must reuse the existing .env loader rather than a third copy');
    // No new dependency, no SDK.
    const requires = [...source.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]);
    for (const dependency of requires) {
      assert.ok(dependency.startsWith('./') || dependency.startsWith('../'), `unexpected dependency: ${dependency}`);
    }
  });

  test('Etsy credentials go through the EXISTING credential architecture', () => {
    for (const key of ['ETSY_API_KEYSTRING', 'ETSY_OAUTH_ACCESS_TOKEN', 'ETSY_SHOP_ID']) {
      assert.ok(CREDENTIAL_KEYS.includes(key), `${key} must be loadable per business`);
    }
    // Additive: the existing keys are all still there.
    for (const key of ['SHOPIFY_STORE_DOMAIN', 'SHOPIFY_ADMIN_API_ACCESS_TOKEN', 'ANTHROPIC_API_KEY']) {
      assert.ok(CREDENTIAL_KEYS.includes(key));
    }
  });

  // --- The missing external capability, reported honestly ---------------------------

  test('the adapter reports its own gaps instead of pretending to work', () => {
    // No Etsy credential is configured in this project, so:
    assert.strictEqual(etsyClient.isConfigured(), false);
    assert.strictEqual(etsyClient.canPublish(), false);
    assert.strictEqual(etsyClient.ETSY_PUBLISHING_STATUS, 'awaiting_verified_api_mapping');
    assert.deepStrictEqual(etsyClient.missingCredentials(), [
      'ETSY_API_KEYSTRING',
      'ETSY_OAUTH_ACCESS_TOKEN',
      'ETSY_SHOP_ID',
    ]);
  });

  await testAsync('the real adapter NEVER reaches the network - it throws before any transport', async () => {
    const savedFetch = global.fetch;
    let fetchCalls = 0;
    global.fetch = async () => {
      fetchCalls += 1;
      throw new Error('no test may make a real network call');
    };
    try {
      await assert.rejects(
        () => etsyClient.publishListing({ listing: LISTING }),
        /not configured|not available/
      );
      assert.strictEqual(fetchCalls, 0, 'the adapter must not attempt a network call');
    } finally {
      global.fetch = savedFetch;
    }
  });

  test('NO ENDPOINT OR ETSY FIELD SHAPE IS INVENTED anywhere in the adapter', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'integrations', 'adapters', 'etsyClient.js'), 'utf8');
    // No URL is asserted for Etsy, because none has been verified.
    assert.ok(!/https?:\/\/[^\s'"`]*etsy/i.test(source), 'no Etsy endpoint URL may be guessed');
    // And no Etsy request field names are asserted either.
    for (const invented of ['taxonomy_id:', 'shipping_profile_id:', 'who_made', 'when_made', 'is_supply']) {
      assert.ok(!source.includes(invented), `the adapter must not assert the Etsy field '${invented}'`);
    }
  });

  // --- ZERO MUTATION: every unauthorized path ---------------------------------------

  await testAsync('UNAUTHORIZED (no such approval) -> zero Etsy mutation', async () => {
    await withMockedEtsy({}, async (calls, assertFetchUntouched) => {
      const outcome = await publish([]);
      assert.strictEqual(outcome.published, false);
      assert.strictEqual(outcome.status, 'refused');
      assert.strictEqual(calls.length, 0);
      assertFetchUntouched();
    });
  });

  await testAsync('PENDING approval -> zero Etsy mutation', async () => {
    await withMockedEtsy({}, async (calls) => {
      const outcome = await publish(pipeline(PASSING_CONTENT, { decision: 'pending' }));
      assert.strictEqual(outcome.status, 'refused');
      assert.strictEqual(outcome.authorization.failed_check, 'human_decision_is_approved');
      assert.strictEqual(calls.length, 0);
    });
  });

  await testAsync('REJECTED approval -> zero Etsy mutation', async () => {
    await withMockedEtsy({}, async (calls) => {
      const outcome = await publish(pipeline(PASSING_CONTENT, { decision: 'rejected' }));
      assert.strictEqual(outcome.status, 'refused');
      assert.strictEqual(outcome.authorization.failed_check, 'human_decision_is_approved');
      assert.strictEqual(calls.length, 0);
    });
  });

  await testAsync('compliance BLOCK -> zero Etsy mutation', async () => {
    await withMockedEtsy({}, async (calls) => {
      // A BLOCK never even becomes an approval request...
      const outcome = await publish(pipeline(BLOCKED_CONTENT));
      assert.strictEqual(outcome.status, 'refused');
      assert.strictEqual(calls.length, 0);

      // ...and an approved record re-pointed at blocked content is refused too.
      const requests = pipeline(PASSING_CONTENT);
      requests[0].execution_request.compliance_input = complianceInput(BLOCKED_CONTENT);
      const retargeted = await publish(requests);
      assert.strictEqual(retargeted.status, 'refused');
      assert.strictEqual(retargeted.authorization.failed_check, 'compliance_not_block');
      assert.strictEqual(calls.length, 0);
    });
  });

  await testAsync('FORGED compliance PASS -> zero Etsy mutation', async () => {
    await withMockedEtsy({}, async (calls) => {
      const requests = pipeline(REVIEW_CONTENT);
      requests[0].execution_request.compliance.compliance_status = 'PASS';
      requests[0].execution_request.compliance.review_reasons = [];
      const outcome = await publish(requests);
      assert.strictEqual(outcome.status, 'refused');
      assert.strictEqual(outcome.authorization.failed_check, 'compliance_attached_and_unchanged');
      assert.strictEqual(calls.length, 0);
    });
  });

  await testAsync('FORGED approval -> zero Etsy mutation', async () => {
    await withMockedEtsy({}, async (calls) => {
      // A hand-built approved record cannot be handed in at all: the workflow takes the
      // server-held array, never a record.
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
      await assert.rejects(() => publish(forged), /server-held/);
      assert.strictEqual(calls.length, 0);

      // And a client-asserted authorization is not a parameter at all - extra keys are
      // simply ignored, so naming one confers nothing.
      const outcome = await publish([], { authorized: true, approved: true, compliance_status: 'PASS' });
      assert.strictEqual(outcome.published, false);
      assert.strictEqual(calls.length, 0);
    });
  });

  await testAsync('WRONG CONTENT REFERENCE -> zero Etsy mutation', async () => {
    await withMockedEtsy({}, async (calls) => {
      const outcome = await publish(pipeline(), { contentReference: OTHER_CONTENT_REFERENCE });
      assert.strictEqual(outcome.status, 'refused');
      assert.strictEqual(outcome.authorization.failed_check, 'approval_matches_content_reference');
      assert.strictEqual(calls.length, 0);
    });
  });

  await testAsync('REVOKED PERMISSION -> zero Etsy mutation', async () => {
    await withMockedEtsy({}, async (calls) => {
      // The same genuinely-approved record, asked on behalf of a specialist that does
      // not own the tool - permission is re-checked at the moment of publishing.
      const outcome = await publish(pipeline(), { specialistId: 'seo' });
      assert.strictEqual(outcome.status, 'refused');
      assert.strictEqual(outcome.authorization.failed_check, 'tool_permission_still_granted');
      assert.strictEqual(calls.length, 0);
    });
  });

  await testAsync('a decision on a classification that never required approval -> zero mutation', async () => {
    await withMockedEtsy({}, async (calls) => {
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
        decidedBy: 'shop-owner@example.com (placeholder)',
      });
      const outcome = await publish(decided);
      assert.strictEqual(outcome.status, 'refused');
      assert.strictEqual(outcome.authorization.failed_check, 'classification_actually_required_approval');
      assert.strictEqual(calls.length, 0);
    });
  });

  await testAsync('authorized but with no listing to publish -> zero Etsy mutation', async () => {
    await withMockedEtsy({}, async (calls) => {
      const outcome = await publish(pipeline(), { listing: undefined });
      assert.strictEqual(outcome.status, 'refused');
      assert.strictEqual(calls.length, 0);
    });
  });

  // --- The one authorized path -------------------------------------------------------

  await testAsync('VALID AUTHORIZATION -> EXACTLY ONE Etsy mutation, with the approved listing', async () => {
    await withMockedEtsy({}, async (calls, assertFetchUntouched) => {
      const outcome = await publish(pipeline());
      assert.strictEqual(outcome.published, true);
      assert.strictEqual(outcome.status, 'published');
      assert.strictEqual(outcome.marketplace, MARKETPLACE);
      assert.strictEqual(calls.length, 1, 'exactly one Etsy mutation');
      assert.deepStrictEqual(calls[0].listing, LISTING);
      assertFetchUntouched();
    });
  });

  await testAsync("Etsy's ACTUAL result is returned, never reshaped or invented", async () => {
    const platformResult = { listing_id: 987654321, state: 'active', url: 'https://example.invalid/placeholder' };
    await withMockedEtsy({ result: platformResult }, async () => {
      const outcome = await publish(pipeline());
      assert.deepStrictEqual(outcome.result, platformResult, "the platform's own result must be relayed unchanged");
    });
  });

  await testAsync('an approved REVIEW publishes, and is still reported as REVIEW', async () => {
    await withMockedEtsy({}, async (calls) => {
      const outcome = await publish(pipeline(REVIEW_CONTENT));
      assert.strictEqual(outcome.published, true);
      assert.strictEqual(calls.length, 1);
      // Approving a REVIEW never rewrites it to PASS.
      assert.strictEqual(outcome.authorization.compliance_status, 'REVIEW');
    });
  });

  // --- Failure handling ---------------------------------------------------------------

  await testAsync('an Etsy failure is handled safely - reported, never a fabricated success', async () => {
    await withMockedEtsy({ throws: 'Etsy returned a placeholder error' }, async (calls) => {
      const outcome = await publish(pipeline());
      assert.strictEqual(outcome.published, false);
      assert.strictEqual(outcome.status, 'failed');
      assert.strictEqual(outcome.result, null, 'a failed publish must carry no result');
      assert.ok(outcome.reason.includes('placeholder error'));
      // It was attempted exactly once - a failure is not silently retried here.
      assert.strictEqual(calls.length, 1);
    });
  });

  await testAsync('the real (unconfigured) adapter fails safely through the workflow', async () => {
    const outcome = await publish(pipeline());
    assert.strictEqual(outcome.published, false);
    assert.strictEqual(outcome.status, 'failed');
    assert.ok(outcome.reason.includes('not configured'));
    assert.ok(outcome.reason.includes('No Etsy call was attempted.'));
  });

  // --- Audit and credential safety ------------------------------------------------------

  await testAsync('AUDIT records the attempt AND the result', async () => {
    const tracker = createAuditTracker('run-etsy-publish-1');
    await withMockedEtsy({}, async () => {
      await publish(pipeline(), { auditTracker: tracker });
    });
    const attempts = getEventsByType(tracker, 'execution').filter((event) => event.status === 'attempted');
    const results = getEventsByType(tracker, 'result');
    assert.strictEqual(attempts.length, 1, 'the attempt must be recorded before the call');
    assert.strictEqual(results.length, 1, 'the result must be recorded after it');
    assert.ok(attempts[0].summary.includes('ATTEMPTED'));
    assert.ok(results[0].summary.includes('SUCCEEDED'));
  });

  await testAsync('AUDIT records a refusal, naming the failed check, with no call made', async () => {
    const tracker = createAuditTracker('run-etsy-publish-2');
    await withMockedEtsy({}, async (calls) => {
      await publish(pipeline(PASSING_CONTENT, { decision: 'rejected' }), { auditTracker: tracker });
      assert.strictEqual(calls.length, 0);
    });
    const refusals = getEventsByType(tracker, 'execution').filter((event) => event.status === 'refused');
    assert.strictEqual(refusals.length, 1);
    assert.ok(refusals[0].summary.includes('No Etsy call was made.'));
  });

  await testAsync('AUDIT records a failed publish as failed', async () => {
    const tracker = createAuditTracker('run-etsy-publish-3');
    await withMockedEtsy({ throws: 'Etsy returned a placeholder error' }, async () => {
      await publish(pipeline(), { auditTracker: tracker });
    });
    const errors = getEventsByType(tracker, 'error');
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].summary.includes('FAILED'));
    assert.strictEqual(getEventsByType(tracker, 'result').length, 0, 'a failure must not be recorded as a result');
  });

  await testAsync('CREDENTIALS ARE NEVER EXPOSED - not in errors, results, or the audit trail', async () => {
    const saved = {
      ETSY_API_KEYSTRING: process.env.ETSY_API_KEYSTRING,
      ETSY_OAUTH_ACCESS_TOKEN: process.env.ETSY_OAUTH_ACCESS_TOKEN,
      ETSY_SHOP_ID: process.env.ETSY_SHOP_ID,
    };
    process.env.ETSY_API_KEYSTRING = 'etsy-keystring-CANARY-DO-NOT-LEAK';
    process.env.ETSY_OAUTH_ACCESS_TOKEN = 'etsy-token-CANARY-DO-NOT-LEAK';
    process.env.ETSY_SHOP_ID = '999999999';
    try {
      // Now "configured", so the adapter reaches its second, honest refusal.
      assert.strictEqual(etsyClient.isConfigured(), true);
      assert.strictEqual(etsyClient.canPublish(), false, 'credentials alone must not imply publish capability');

      const tracker = createAuditTracker('run-etsy-publish-4');
      const outcome = await publish(pipeline(), { auditTracker: tracker });
      assert.strictEqual(outcome.status, 'failed');

      const everything = JSON.stringify(outcome) + JSON.stringify(tracker) + outcome.reason;
      for (const canary of ['etsy-keystring-CANARY-DO-NOT-LEAK', 'etsy-token-CANARY-DO-NOT-LEAK']) {
        assert.ok(!everything.includes(canary), 'a credential value leaked');
      }
      // Missing-credential reporting names KEYS only, never values.
      assert.deepStrictEqual(etsyClient.missingCredentials(), []);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  // --- No automatic publishing, and no AI ------------------------------------------------

  test('THERE IS EXACTLY ONE ADAPTER CALL SITE, past the authorization branch', () => {
    // Scan the CODE, not the header comment that explains the single-call-site rule.
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'integrations', 'etsyPublishing.js'), 'utf8');
    const code = source.replace(/^\s*\/\/.*$/gm, '');
    const callSites = code.match(/etsyClient\.publishListing\(/g) || [];
    assert.strictEqual(callSites.length, 1, 'more than one call site would be more than one thing to audit');
    // The authorization check precedes it in the file, and there is no other gate.
    assert.ok(code.indexOf('authorizePublishing(') < code.indexOf('etsyClient.publishListing('));
  });

  test('NO AI CALL is involved in publishing', () => {
    for (const file of ['integrations/etsyPublishing.js', 'integrations/adapters/etsyClient.js']) {
      // Again the CODE only - a comment may legitimately cite another module's header
      // as the source of a convention this file follows.
      const code = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8').replace(/^\s*\/\/.*$/gm, '');
      for (const forbidden of ['aiReasoningCompletion', 'claudeClient', 'geminiClient', 'aiProviderSelector']) {
        assert.ok(!code.includes(forbidden), `${file} must not reference ${forbidden}`);
      }
    }
  });

  test('NO OTHER MARKETPLACE was implemented', () => {
    for (const file of ['integrations/etsyPublishing.js', 'integrations/adapters/etsyClient.js']) {
      const source = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8').toLowerCase();
      for (const forbidden of ['amazon', 'ebay', 'woocommerce']) {
        assert.ok(!source.includes(forbidden), `${file} must not reference ${forbidden}`);
      }
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
