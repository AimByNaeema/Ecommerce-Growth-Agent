'use strict';

// Tests for the seo_quality_check tool (tools/seoQualityCheckTool.js) - the wiring that
// makes agent/core/seoQualityChecker.js reachable through the Chief/orchestrator.
//
// WHAT THIS CHANGE WAS. checkSeoQuality() was already built and fully tested
// (seoQualityChecker.test.js still owns every dimension-check assertion), but nothing
// in production could reach it: it was called from no tool, no capability, and no
// workflow - only from its own test. It turned out to be a genuinely reusable SEO
// specialist capability (one already-built listingOptimizationModel.js record in, one
// structured quality audit out, no workflow sequencing of its own), so it is now wired
// as the SEO `seo_quality_check` capability, the same treatment
// tools/offerRecommendationTool.js gave agent/core/offerRecommendationEngine.js for
// Marketing.
//
// These tests cover only the connecting wiring: the dispatch, the registry/permission
// entries, and real reachability through the shared Chief execution stack (permissions,
// audit, usage ledger). No check-dimension logic is re-tested here, and none was
// rewritten.
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

const { runSeoQualityCheckTool } = require('../../tools/seoQualityCheckTool');
const { validateSeoQualityCheckShape } = require('../../agent/core/seoQualityCheckModel');
const { createEmptyListingOptimizationRecord } = require('../../agent/core/listingOptimizationModel');
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

function keyword(text, overrides = {}) {
  const record = createEmptySeoResearchRecord(text);
  Object.assign(record, overrides);
  return record;
}

// Every one of the 9 dimensions supplied and satisfied -> quality_score.status 'success'.
function buildFullyCovered() {
  const listingRecord = createEmptyListingOptimizationRecord('(placeholder) insulated hiking jacket');
  listingRecord.product_title = 'Insulated Hiking Jacket for Cold Weather Hikes';
  listingRecord.description =
    'A warm, waterproof shell built for long days outdoors, with a fitted hood and reinforced seams.';
  listingRecord.keywords = ['insulated hiking jacket'];
  listingRecord.search_intent = 'commercial investigation';
  listingRecord.headings = [{ level: 'h1', text: 'Built for Cold-Weather Trails' }];
  listingRecord.metadata = {
    meta_title: 'Insulated Hiking Jacket | Store',
    meta_description:
      'A warm, waterproof shell for cold-weather hikes, with a fitted hood and reinforced seams for long days outdoors.',
    url_slug: 'insulated-hiking-jacket',
    alt_text: 'Insulated hiking jacket product photo',
  };
  listingRecord.internal_links = [{ anchor_text: 'outdoor apparel collection', target: 'outdoor-apparel' }];
  listingRecord.supporting_content = ['Add a cold-weather layering buying guide.'];

  return {
    listingRecord,
    keywordRecords: [keyword('insulated hiking jacket', { search_intent: 'commercial investigation' })],
    factualAttributes: ['waterproof'],
  };
}

// Title and description present, nothing else -> some dimensions succeed, most stay
// empty (no keywords/metadata/links supplied) -> quality_score.status 'partial'.
function buildPartiallyCovered() {
  const listingRecord = createEmptyListingOptimizationRecord('(placeholder) insulated hiking jacket');
  listingRecord.product_title = 'Insulated Hiking Jacket For Cold Trails';
  listingRecord.description = 'A caller-supplied placeholder description text of reasonable length for the checker.';
  return { listingRecord };
}

// A valid, empty listing record and nothing else -> no dimension has anything to work
// with -> 'empty'. Honest, not a failure.
function buildNothingSupplied() {
  return { listingRecord: createEmptyListingOptimizationRecord('(placeholder) insulated hiking jacket') };
}

const FULLY_COVERED = buildFullyCovered();
const PARTIALLY_COVERED = buildPartiallyCovered();
const NOTHING_SUPPLIED = buildNothingSupplied();

// --------------------------------------------------------------------------------
// 1. Dispatch - the tool relays the checker's own result and its own status.
// --------------------------------------------------------------------------------

test('the tool returns the checker\'s real, schema-valid record', () => {
  const outcome = runSeoQualityCheckTool(FULLY_COVERED);
  assert.strictEqual(outcome.status, 'success');
  assert.strictEqual(outcome.error, null);
  assert.ok(validateSeoQualityCheckShape(outcome.result).valid);
  assert.strictEqual(outcome.result.subject_reference, FULLY_COVERED.listingRecord.product_reference);
});

test('status is read straight off the checker\'s own quality_score.status, never recomputed', () => {
  for (const params of [FULLY_COVERED, PARTIALLY_COVERED, NOTHING_SUPPLIED]) {
    const outcome = runSeoQualityCheckTool(params);
    assert.strictEqual(outcome.status, outcome.result.quality_score.status);
  }
});

test('all three honest outcomes are reachable: success, partial, empty', () => {
  assert.strictEqual(runSeoQualityCheckTool(FULLY_COVERED).status, 'success');
  assert.strictEqual(runSeoQualityCheckTool(PARTIALLY_COVERED).status, 'partial');
  assert.strictEqual(runSeoQualityCheckTool(NOTHING_SUPPLIED).status, 'empty');
});

// --------------------------------------------------------------------------------
// 2. Honesty - it never throws, never invents, and says why it failed.
// --------------------------------------------------------------------------------

test('no structured input is reported as failed, not guessed from an objective', () => {
  for (const bad of [undefined, null, 'a free-text objective', 42]) {
    const outcome = runSeoQualityCheckTool(bad);
    assert.strictEqual(outcome.status, 'failed');
    assert.strictEqual(outcome.result, null);
    assert.ok(outcome.error.includes('No structured research input was supplied'));
  }
});

test('a checker rejection becomes a failed status carrying the checker\'s own message - never a throw', () => {
  const missingListing = runSeoQualityCheckTool({ keywordRecords: [] });
  assert.strictEqual(missingListing.status, 'failed');
  assert.ok(missingListing.error.includes('listingOptimizationModel.js record'));

  const badKeyword = runSeoQualityCheckTool({
    listingRecord: NOTHING_SUPPLIED.listingRecord,
    keywordRecords: [{ not_a_real: 'keyword' }],
  });
  assert.strictEqual(badKeyword.status, 'failed');
  assert.ok(badKeyword.error.includes('keyword record'));
});

test('an empty result still names, per dimension, what was missing - nothing is silently skipped', () => {
  const outcome = runSeoQualityCheckTool(NOTHING_SUPPLIED);
  assert.strictEqual(outcome.result.dimension_gaps.length, 9);
  for (const gap of outcome.result.dimension_gaps) {
    assert.ok(gap.reason && gap.reason.trim() !== '', `${gap.dimension} has no reason`);
  }
});

// --------------------------------------------------------------------------------
// 3. Anti-duplication - the tool wraps the checker, it does not restate it.
// --------------------------------------------------------------------------------

test('the tool file contains no dimension-check logic of its own - it only calls the checker', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'seoQualityCheckTool.js'), 'utf8');
  const body = source
    .split('if (require.main === module)')[0]
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  assert.ok(!body.includes('SEO_QUALITY_DIMENSIONS'), 'the dimension list must stay in the checker');
  assert.ok(!body.includes('DIMENSION_CHECKS'), 'the per-dimension checks must stay in the checker');
  assert.strictEqual((body.match(/checkSeoQuality\(/g) || []).length, 1, 'exactly one checker call site');
});

test('the existing on_page_seo capability is untouched and still runs on seo_analysis - no second route', () => {
  assert.deepStrictEqual(getCapabilityTask('seo', 'on_page_seo').tool_ids, ['seo_analysis']);
  assert.strictEqual(getCapabilityTask('seo', 'on_page_seo').output_contract.model, 'agent/core/seoAgentResultModel.js');
  assert.strictEqual(
    getCapabilityTask('seo', 'seo_quality_check').output_contract.model,
    'agent/core/seoQualityCheckModel.js'
  );
});

// --------------------------------------------------------------------------------
// 4. Registry, permissions and usage entries.
// --------------------------------------------------------------------------------

test('seo_quality_check is a real, implemented SEO tool the capability points at', () => {
  const tool = getToolById('seo_quality_check');
  assert.strictEqual(tool.status, 'implemented');
  assert.strictEqual(tool.category, 'seo');
  // 'read' matches SPECIALIST_ROLE_PERMISSIONS.seo, which covers both read and write.
  assert.strictEqual(tool.operation, 'read');
  assert.deepStrictEqual(getCapabilityTask('seo', 'seo_quality_check').tool_ids, ['seo_quality_check']);
  assert.ok(getSpecialistCapabilityById('seo').required_tools.includes('seo_quality_check'));
});

test('the capability is analysis_only, allowed to SEO, and denied to every other specialist', () => {
  assert.strictEqual(TOOL_CLASSIFICATIONS.seo_quality_check, 'analysis_only');
  const allowed = checkToolAccess({ specialistId: 'seo', toolId: 'seo_quality_check' });
  assert.strictEqual(allowed.decision, 'allowed');
  assert.strictEqual(allowed.approval_required, false);
  for (const specialistId of ['research', 'product', 'listing', 'marketing', 'social_advertising', 'analytics_optimization']) {
    assert.strictEqual(
      checkToolAccess({ specialistId, toolId: 'seo_quality_check' }).decision,
      'denied',
      `${specialistId} must not have access`
    );
  }
});

test('it counts against no external-API, model-call or research budget - it makes none of those calls', () => {
  assert.ok(!EXTERNAL_API_TOOL_IDS.has('seo_quality_check'));
  assert.ok(!MODEL_CALL_TOOL_IDS.has('seo_quality_check'));
  assert.ok(!RESEARCH_TOOL_IDS.has('seo_quality_check'));
});

test('the input contract matches what the checker actually requires', () => {
  const contract = getCapabilityTask('seo', 'seo_quality_check').input_contract;
  assert.deepStrictEqual(contract.required, ['listingRecord']);
  for (const field of ['keywordRecords', 'factualAttributes', 'researchDate']) {
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
    ['Audit this SEO listing for quality gaps.', FULLY_COVERED, 'success'],
    ['Audit this SEO listing for quality gaps.', PARTIALLY_COVERED, 'partial'],
    ['Audit this SEO listing for quality gaps.', NOTHING_SUPPLIED, 'empty'],
  ];

  for (const [objective, researchParams, expectedStatus] of CASES) {
    await testAsync(`REACHABLE THROUGH CHIEF: forced dispatch of seo_quality_check executes for real (${expectedStatus})`, async () => {
      const runAuditTracker = createAuditTracker('seo-quality-check-test-run', null);
      const runUsageLedger = createUsageLedger('seo-quality-check-test-run', null);
      const runUsageTracker = createUsageTracker();

      const step = await orchestratorExecutionContract.buildPlanStep(
        orchestratorExecutionContract.buildSpecialistTarget('seo'),
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
        { toolId: 'seo_quality_check', capabilityId: 'seo_quality_check' }
      );

      assert.strictEqual(step.inputs.tool_id, 'seo_quality_check');
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
    assert.ok(TEST_FILES.includes('seoQualityCheckCapability.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
})();
