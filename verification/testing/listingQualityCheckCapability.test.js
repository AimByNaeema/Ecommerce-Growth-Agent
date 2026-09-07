'use strict';

// Tests for the listing_quality_check tool (tools/listingQualityCheckTool.js) - the
// wiring that makes agent/core/listingQualityChecker.js reachable through the
// Chief/orchestrator.
//
// WHAT THIS CHANGE WAS. checkListingQuality() was already built and fully tested
// (listingQualityChecker.test.js still owns every dimension-check assertion), but
// nothing in production could reach it: it was called from no tool, no capability, and
// no workflow - only from its own test. It turned out to be a genuinely reusable
// Listing specialist capability (one already-built listingContentModel.js record in,
// one structured quality audit out, no workflow sequencing of its own), so it is now
// wired as the Listing `listing_quality_check` capability, the same treatment
// tools/offerRecommendationTool.js gave agent/core/offerRecommendationEngine.js for
// Marketing.
//
// These tests cover only the connecting wiring: the dispatch, the registry/permission
// entries, and real reachability through the shared Chief execution stack (permissions,
// audit, usage ledger). No check-dimension logic is re-tested here, and none was
// rewritten.
//
// WHY 'write' OPERATION for a conceptually read-only audit: agent/core/toolPermissions.js's
// SPECIALIST_ROLE_PERMISSIONS scopes Listing to ['write'] only (content-creation
// role, no read/analysis operations) - the exact same constraint that made
// tools/offerRecommendationTool.js's offer_recommendation 'write' for Marketing's
// identical write-only role. Asserted below rather than assumed.
//
// WHY forced-selection dispatch rather than free-text objective routing: this
// capability's required input is a whole already-built listingRecord object, which no
// free-text objective can supply - the same reason seoContentGenerationTool.test.js and
// marketQuestionDiscoveryTool.test.js exercise real Chief dispatch via
// orchestratorExecutionContract.buildPlanStep()'s forcedSelection rather than
// runOrchestratorContract() word-overlap routing.
//
// Every value below is an invented placeholder. No network call is made anywhere.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { runListingQualityCheckTool } = require('../../tools/listingQualityCheckTool');
const { validateListingQualityCheckShape } = require('../../agent/core/listingQualityCheckModel');
const { createEmptyListingContentRecord } = require('../../agent/core/listingContentModel');
const { createEmptySeoResearchRecord } = require('../../agent/core/seoResearchModel');
const { getCapabilityTask, getSpecialistCapabilityById } = require('../../agent/core/specialistCapabilityRegistry');
const { checkToolAccess, TOOL_CLASSIFICATIONS } = require('../../agent/core/toolPermissions');
const { MODEL_CALL_TOOL_IDS, EXTERNAL_API_TOOL_IDS, RESEARCH_TOOL_IDS } = require('../../agent/core/usageLimits');
const { getToolById } = require('../../tools/toolRegistry');
const orchestratorExecutionContract = require('../../agent/core/orchestratorExecutionContract');
const { createAuditTracker } = require('../../audit/auditTrail');
const { createUsageLedger } = require('../../usage/usageTracker');
const { createToolResultCache } = require('../../agent/core/toolResultCache');
const { createUsageTracker } = require('../../agent/core/usageLimits');

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

// --------------------------------------------------------------------------------
// Placeholder fixtures - caller-supplied input only, the only thing this checker will
// ever audit.
// --------------------------------------------------------------------------------

function keyword(text, source = ['(placeholder source)']) {
  const record = createEmptySeoResearchRecord(text);
  record.source = source;
  return record;
}

// Every one of the 8 dimensions supplied and satisfied -> quality_score.status 'success'.
function buildFullyCovered() {
  const listingRecord = createEmptyListingContentRecord('(placeholder) insulated hiking jacket');
  listingRecord.product_title = 'Insulated Hiking Jacket';
  listingRecord.description = 'A warm, waterproof jacket built for cold weekend hikes and everyday winter wear.';
  listingRecord.benefits = ['Keeps you warm on cold hikes.'];
  listingRecord.features = ['Waterproof shell.'];
  listingRecord.selling_points = ['Lighter than comparable jackets.'];
  listingRecord.faqs = [{ question: 'Is it machine washable?', answer: 'Cold wash only, addresses waterproof concerns too.' }];
  listingRecord.attributes = [{ name: 'material', value: 'ripstop nylon' }];
  listingRecord.variants = [{ variant_reference: '(variant M)', title: 'Medium' }];
  listingRecord.cta = 'Shop the collection now.';

  return {
    listingRecord,
    keywordRecords: [keyword('insulated hiking jacket')],
    factualAttributes: ['waterproof'],
    customerObjections: ['machine washable'],
  };
}

// Title present, nothing else -> some dimensions succeed/partial, most stay empty ->
// quality_score.status 'partial'.
function buildPartiallyCovered() {
  const listingRecord = createEmptyListingContentRecord('(placeholder) insulated hiking jacket');
  listingRecord.product_title = 'Insulated Hiking Jacket';
  return { listingRecord };
}

// A valid, empty listing record and nothing else -> no dimension has anything to work
// with -> 'empty'. Honest, not a failure.
function buildNothingSupplied() {
  return { listingRecord: createEmptyListingContentRecord('(placeholder) insulated hiking jacket') };
}

const FULLY_COVERED = buildFullyCovered();
const PARTIALLY_COVERED = buildPartiallyCovered();
const NOTHING_SUPPLIED = buildNothingSupplied();

// --------------------------------------------------------------------------------
// 1. Dispatch - the tool relays the checker's own result and its own status.
// --------------------------------------------------------------------------------

test('the tool returns the checker\'s real, schema-valid record', () => {
  const outcome = runListingQualityCheckTool(FULLY_COVERED);
  assert.strictEqual(outcome.status, 'success');
  assert.strictEqual(outcome.error, null);
  assert.ok(validateListingQualityCheckShape(outcome.result).valid);
  assert.strictEqual(outcome.result.subject_reference, FULLY_COVERED.listingRecord.product_reference);
});

test('status is read straight off the checker\'s own quality_score.status, never recomputed', () => {
  for (const params of [FULLY_COVERED, PARTIALLY_COVERED, NOTHING_SUPPLIED]) {
    const outcome = runListingQualityCheckTool(params);
    assert.strictEqual(outcome.status, outcome.result.quality_score.status);
  }
});

test('all three honest outcomes are reachable: success, partial, empty', () => {
  assert.strictEqual(runListingQualityCheckTool(FULLY_COVERED).status, 'success');
  assert.strictEqual(runListingQualityCheckTool(PARTIALLY_COVERED).status, 'partial');
  assert.strictEqual(runListingQualityCheckTool(NOTHING_SUPPLIED).status, 'empty');
});

// --------------------------------------------------------------------------------
// 2. Honesty - it never throws, never invents, and says why it failed.
// --------------------------------------------------------------------------------

test('no structured input is reported as failed, not guessed from an objective', () => {
  for (const bad of [undefined, null, 'a free-text objective', 42]) {
    const outcome = runListingQualityCheckTool(bad);
    assert.strictEqual(outcome.status, 'failed');
    assert.strictEqual(outcome.result, null);
    assert.ok(outcome.error.includes('No structured research input was supplied'));
  }
});

test('a checker rejection becomes a failed status carrying the checker\'s own message - never a throw', () => {
  const missingListing = runListingQualityCheckTool({ keywordRecords: [] });
  assert.strictEqual(missingListing.status, 'failed');
  assert.ok(missingListing.error.includes('listingContentModel.js record'));

  const badKeyword = runListingQualityCheckTool({
    listingRecord: NOTHING_SUPPLIED.listingRecord,
    keywordRecords: [{ not_a_real: 'keyword' }],
  });
  assert.strictEqual(badKeyword.status, 'failed');
  assert.ok(badKeyword.error.includes('keyword record'));
});

test('an empty result still names, per dimension, what was missing - nothing is silently skipped', () => {
  const outcome = runListingQualityCheckTool(NOTHING_SUPPLIED);
  for (const status of Object.values(outcome.result.dimension_status)) {
    assert.strictEqual(status, 'empty');
  }
});

// --------------------------------------------------------------------------------
// 3. Anti-duplication - the tool wraps the checker, it does not restate it.
// --------------------------------------------------------------------------------

test('the tool file contains no dimension-check logic of its own - it only calls the checker', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'listingQualityCheckTool.js'), 'utf8');
  const body = source
    .split('if (require.main === module)')[0]
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  assert.ok(!body.includes('LISTING_QUALITY_DIMENSIONS'), 'the dimension list must stay in the checker');
  assert.ok(!body.includes('DIMENSION_CHECKS'), 'the per-dimension checks must stay in the checker');
  assert.ok(!body.includes('CLAIM_TRIGGER_PHRASES'), 'claim scanning must stay in the checker');
  assert.strictEqual((body.match(/checkListingQuality\(/g) || []).length, 1, 'exactly one checker call site');
});

test('the existing listing_content capability is untouched and still runs on listing_content_generation - no second route', () => {
  assert.deepStrictEqual(getCapabilityTask('listing', 'listing_content').tool_ids, ['listing_content_generation']);
  assert.strictEqual(
    getCapabilityTask('listing', 'listing_content').output_contract.model,
    'agent/core/listingAgentResultModel.js'
  );
  assert.strictEqual(
    getCapabilityTask('listing', 'listing_quality_check').output_contract.model,
    'agent/core/listingQualityCheckModel.js'
  );
});

// --------------------------------------------------------------------------------
// 4. Registry, permissions and usage entries.
// --------------------------------------------------------------------------------

test('listing_quality_check is a real, implemented Listing tool the capability points at', () => {
  const tool = getToolById('listing_quality_check');
  assert.strictEqual(tool.status, 'implemented');
  assert.strictEqual(tool.category, 'listing');
  // 'write' matches SPECIALIST_ROLE_PERMISSIONS.listing, which covers write only - a
  // 'read' tool in this category would be denied to Listing itself.
  assert.strictEqual(tool.operation, 'write');
  assert.deepStrictEqual(getCapabilityTask('listing', 'listing_quality_check').tool_ids, ['listing_quality_check']);
  assert.ok(getSpecialistCapabilityById('listing').required_tools.includes('listing_quality_check'));
});

test('the capability is analysis_only, allowed to Listing, and denied to every other specialist', () => {
  assert.strictEqual(TOOL_CLASSIFICATIONS.listing_quality_check, 'analysis_only');
  const allowed = checkToolAccess({ specialistId: 'listing', toolId: 'listing_quality_check' });
  assert.strictEqual(allowed.decision, 'allowed');
  assert.strictEqual(allowed.approval_required, false);
  for (const specialistId of ['research', 'product', 'seo', 'marketing', 'social_advertising', 'analytics_optimization']) {
    assert.strictEqual(
      checkToolAccess({ specialistId, toolId: 'listing_quality_check' }).decision,
      'denied',
      `${specialistId} must not have access`
    );
  }
});

test('it counts against no external-API, model-call or research budget - it makes none of those calls', () => {
  assert.ok(!EXTERNAL_API_TOOL_IDS.has('listing_quality_check'));
  assert.ok(!MODEL_CALL_TOOL_IDS.has('listing_quality_check'));
  assert.ok(!RESEARCH_TOOL_IDS.has('listing_quality_check'));
});

test('the input contract matches what the checker actually requires', () => {
  const contract = getCapabilityTask('listing', 'listing_quality_check').input_contract;
  assert.deepStrictEqual(contract.required, ['listingRecord']);
  for (const field of ['keywordRecords', 'factualAttributes', 'customerObjections', 'researchDate']) {
    assert.ok(contract.optional.includes(field), `${field} is missing from the contract`);
  }
});

// --------------------------------------------------------------------------------
// 5. Real reachability through Chief - the point of the whole change. Forced
// selection is used (not free-text word-overlap routing) because the required input
// is a whole listingRecord object, which no objective string can supply - the same
// pattern seoContentGenerationTool.test.js and marketQuestionDiscoveryTool.test.js use.
// --------------------------------------------------------------------------------

(async () => {
  const CASES = [
    ['Audit this listing content for quality gaps.', FULLY_COVERED, 'success'],
    ['Audit this listing content for quality gaps.', PARTIALLY_COVERED, 'partial'],
    ['Audit this listing content for quality gaps.', NOTHING_SUPPLIED, 'empty'],
  ];

  for (const [objective, researchParams, expectedStatus] of CASES) {
    await testAsync(`REACHABLE THROUGH CHIEF: forced dispatch of listing_quality_check executes for real (${expectedStatus})`, async () => {
      const runAuditTracker = createAuditTracker('listing-quality-check-test-run', null);
      const runUsageLedger = createUsageLedger('listing-quality-check-test-run', null);
      const runUsageTracker = createUsageTracker();

      const step = await orchestratorExecutionContract.buildPlanStep(
        orchestratorExecutionContract.buildSpecialistTarget('listing'),
        objective,
        objective,
        { tokensUsedThisRun: 0 },
        researchParams,
        [],
        { requests: [] },
        runAuditTracker,
        createToolResultCache(),
        runUsageTracker,
        null,
        runUsageLedger,
        { toolId: 'listing_quality_check', capabilityId: 'listing_quality_check' }
      );

      assert.strictEqual(step.inputs.tool_id, 'listing_quality_check');
      // A tool-level 'success' is verified and 'complete'; 'partial'/'empty' are real,
      // honest outcomes but not independently verified, so they stay 'blocked' -
      // exactly agent/core/executionState.js's documented rule for every tool-status
      // convention result, not something specific to this capability.
      assert.strictEqual(step.completion_state, expectedStatus === 'success' ? 'complete' : 'blocked');
      assert.strictEqual(step.outputs.status, expectedStatus);
      assert.ok(step.outputs.result, 'the capability must have produced a real result');

      const auditTypes = runAuditTracker.events.map((event) => event.type);
      assert.ok(auditTypes.includes('tools'));
      assert.ok(auditTypes.includes('execution'));

      // No model call, no external call - purely a caller-supplied-record audit.
      assert.strictEqual(runUsageTracker.modelCalls, 0);
      assert.strictEqual(runUsageTracker.externalApiCalls, 0);
    });
  }

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('listingQualityCheckCapability.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
})();
