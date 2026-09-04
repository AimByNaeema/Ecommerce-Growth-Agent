'use strict';

// Integration tests for the Information Gap Finder as an exposed SEO capability:
//
//   agent/core/seoAgent.js's runSeoAgent({ capability: 'information_gap_analysis' })
//   -> tools/seoAnalysisTool.js's researchParams.seoCapability mode
//   -> the real shared execution stack (agent/core/orchestratorExecutionContract.js's
//      buildPlanStep), proving permissions, token/usage controls and audit still apply.
//
// agent/core/informationGapEngine.js's own behavior is covered by
// verification/testing/informationGapEngine.test.js - this file is about the wiring.
//
// NO REAL EXTERNAL CALL. The pinned tool (seo_analysis) dispatches to local,
// deterministic code with no network, model, or store access, so the shared-stack test
// at the bottom runs the genuine machinery unmocked without reaching Gemini, Claude,
// Shopify, or any advertising API.

const assert = require('node:assert');

const { runSeoAgent, analyzeInformationGaps } = require('../../agent/core/seoAgent');
const { SEO_CAPABILITIES, validateSeoAgentResultShape } = require('../../agent/core/seoAgentResultModel');
const { runSeoAnalysisTool } = require('../../tools/seoAnalysisTool');
const { validateInformationGapShape } = require('../../agent/core/informationGapModel');
const { checkToolAccess } = require('../../agent/core/toolPermissions');
const { getCapabilityTask } = require('../../agent/core/specialistCapabilityRegistry');
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

const QUESTIONS = [
  {
    question: 'How do I wash an insulated jacket without ruining the loft?',
    questionType: 'troubleshooting',
    evidenceSources: [{ signalKind: 'product_review_question', reference: '(placeholder review reference)' }],
    competitorObservations: [
      { competitor: '(Example Co. A)', covered: false },
      { competitor: '(Example Co. B)', covered: false },
    ],
    businessRelevance: 'high',
    productContext: '(Example insulated jacket)',
  },
];

// --- Exposure through the SEO agent ---------------------------------------------

test('information_gap_analysis is a registered SEO capability', () => {
  assert.ok(SEO_CAPABILITIES.includes('information_gap_analysis'));
});

test('the capability registry declares it against the existing seo_analysis tool', () => {
  const task = getCapabilityTask('seo', 'information_gap_analysis');
  assert.ok(task, 'information_gap_analysis is missing from the SEO specialist capability registry');
  // Reuses the existing tool rather than introducing a second SEO tool.
  assert.deepStrictEqual(task.tool_ids, ['seo_analysis']);
  assert.ok(task.input_contract.required.includes('questions'));
});

test('runSeoAgent dispatches the capability and returns a valid SEO result envelope', () => {
  const result = runSeoAgent({ capability: 'information_gap_analysis', questions: QUESTIONS });
  assert.strictEqual(result.capability, 'information_gap_analysis');
  assert.strictEqual(validateSeoAgentResultShape(result).valid, true);
  assert.strictEqual(result.specialized_records.length, 1);
  assert.strictEqual(validateInformationGapShape(result.specialized_records[0]).valid, true);
});

test('findings relay each record\'s real status, score and provenance - not a verdict of the agent\'s own', () => {
  const result = analyzeInformationGaps({ questions: QUESTIONS });
  assert.strictEqual(result.findings.length, 1);
  assert.ok(result.findings[0].includes('[opportunity]'));
  assert.ok(result.findings[0].includes('evidence: observed'));
  assert.ok(result.findings[0].includes('gap: missing_troubleshooting'));
});

test('an unevidenced question keeps verification_status honest rather than being upgraded', () => {
  const result = analyzeInformationGaps({
    questions: [{ question: 'An entirely unsupported question about sizing?' }],
    // A caller asserting 'verified' with no evidence anywhere must not be taken at face
    // value - composeResult's existing honesty guard downgrades it.
    verificationStatus: 'verified',
  });
  assert.strictEqual(result.verification_status, 'unverified');
  assert.strictEqual(result.specialized_records[0].status, 'review');
  assert.ok(result.limitations.some((limitation) => limitation.includes('downgraded to unverified')));
});

test('the shared envelope carries the engine\'s honest limitations, including the Compliance gap', () => {
  const result = analyzeInformationGaps({ questions: QUESTIONS });
  assert.ok(result.limitations.some((limitation) => limitation.includes('No live question-discovery source')));
  assert.ok(result.limitations.some((limitation) => limitation.includes('No search volume')));
  assert.ok(result.limitations.some((limitation) => limitation.includes('Compliance')));
});

// --- Exposure through the existing seo_analysis tool -----------------------------

test('the seo_analysis tool runs the capability and reports an honest status', () => {
  const outcome = runSeoAnalysisTool({ seoCapability: 'information_gap_analysis', questions: QUESTIONS });
  assert.strictEqual(outcome.status, 'success');
  assert.strictEqual(outcome.error, null);
  assert.strictEqual(outcome.result.capability, 'information_gap_analysis');
});

test('the tool reports empty - not success - when no evidence was supplied anywhere', () => {
  const outcome = runSeoAnalysisTool({
    seoCapability: 'information_gap_analysis',
    questions: [{ question: 'An unsupported question?' }],
  });
  assert.strictEqual(outcome.status, 'empty');
});

test('the tool fails honestly on missing input instead of guessing questions', () => {
  const noParams = runSeoAnalysisTool(undefined);
  assert.strictEqual(noParams.status, 'failed');

  const noQuestions = runSeoAnalysisTool({ seoCapability: 'information_gap_analysis' });
  assert.strictEqual(noQuestions.status, 'failed');
  assert.ok(noQuestions.error.includes('questions'));
  assert.strictEqual(noQuestions.result, null);
});

test('the other seo_analysis modes still work unchanged', () => {
  // The new mode is additive - it must not disturb the five that were already exposed.
  const productSeo = runSeoAnalysisTool({ productReference: '(Example insulated jacket)' });
  assert.strictEqual(productSeo.result.capability, 'product_seo');
  const collectionSeo = runSeoAnalysisTool({ seoCapability: 'collection_seo', collectionReference: '(Example collection)' });
  assert.strictEqual(collectionSeo.result.capability, 'collection_seo');
});

// --- Permissions, cost controls and audit remain enforced ------------------------

test('the existing permission gate governs this capability - it is not a new surface', () => {
  const allowed = checkToolAccess({ specialistId: 'seo', toolId: 'seo_analysis' });
  assert.strictEqual(allowed.decision, 'allowed');
  // And a specialist that does not own the SEO category still cannot reach it.
  const denied = checkToolAccess({ specialistId: 'marketing', toolId: 'seo_analysis' });
  assert.strictEqual(denied.decision, 'denied');
});

(async () => {
  await testAsync('an UNMOCKED run through buildPlanStep enforces permissions and records audit + usage', async () => {
    // The real shared execution stack, nothing stubbed. seo_analysis dispatches to local
    // deterministic code, so this makes no external call.
    const runAuditTracker = createAuditTracker('information-gap-test-run', null);
    const runUsageLedger = createUsageLedger('information-gap-test-run', null);
    const runTokenTracker = { tokensUsedThisRun: 0 };
    const runUsageTracker = createUsageTracker();

    const step = await orchestratorExecutionContract.buildPlanStep(
      orchestratorExecutionContract.buildSpecialistTarget('seo'),
      'Find real questions our competitors answer poorly.',
      'Find real questions our competitors answer poorly.',
      runTokenTracker,
      { questions: QUESTIONS },
      [],
      { requests: [] },
      runAuditTracker,
      createToolResultCache(),
      runUsageTracker,
      null,
      runUsageLedger,
      { toolId: 'seo_analysis', capabilityId: 'information_gap_analysis' }
    );

    // The pinned capability really was the one dispatched.
    assert.strictEqual(step.inputs.tool_id, 'seo_analysis');
    assert.strictEqual(step.inputs.capability_id, 'information_gap_analysis');
    assert.deepStrictEqual(step.tool_calls, ['seo_analysis']);
    assert.strictEqual(step.completion_state, 'complete');
    assert.strictEqual(step.outputs.result.capability, 'information_gap_analysis');

    // Audit and usage recorded it exactly as they do every other tool call.
    const auditTypes = runAuditTracker.events.map((event) => event.type);
    assert.ok(auditTypes.includes('tools'), 'no permission/tool-selection audit event was produced');
    assert.ok(auditTypes.includes('execution'), 'no execution audit event was produced');
    assert.ok(runUsageLedger.events.length > 0, 'nothing was written to the usage ledger');

    // The caller-held cost trackers were threaded through, not bypassed.
    assert.strictEqual(runUsageTracker.toolCalls, 1);
    // This capability is deterministic and makes no model call, so it must not consume
    // model tokens - the trackers are still present and enforced either way.
    assert.strictEqual(runUsageTracker.modelCalls, 0);
    assert.strictEqual(runTokenTracker.tokensUsedThisRun, 0);
  });

  await testAsync('nothing in this capability is approval-gated away or auto-published', async () => {
    const step = await orchestratorExecutionContract.buildPlanStep(
      orchestratorExecutionContract.buildSpecialistTarget('seo'),
      'Find information gaps.',
      'Find information gaps.',
      { tokensUsedThisRun: 0 },
      { questions: QUESTIONS },
      [],
      { requests: [] },
      createAuditTracker('information-gap-approval-test', null),
      createToolResultCache(),
      createUsageTracker(),
      null,
      createUsageLedger('information-gap-approval-test', null),
      { toolId: 'seo_analysis', capabilityId: 'information_gap_analysis' }
    );

    // Analysis only: it identifies and prioritizes opportunities and never publishes, so
    // it is correctly not an approval_required action - and it produces no content to
    // publish in the first place.
    assert.strictEqual(orchestratorExecutionContract.isGatedForApproval(step), false);
    const record = step.outputs.result.specialized_records[0];
    assert.ok(record.recommended_content_type, 'a content type should be recommended for the downstream generator');
    assert.ok(!('generated_content' in record), 'this capability must not generate content itself');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
