'use strict';

// EXECUTE -> VERIFY -> AUDIT -> PERSIST -> LEARN -> NEXT CYCLE, through the real trigger.
//
// Proves that what one autonomous cycle concludes reaches the next one through the EXISTING
// stores only - run history, the execution-verification store, the memory layer, the circuit
// breaker, the schedule's occurrence claim and the durable approval store - and that none of
// them becomes a way to store a credential, leak across businesses, remember something that
// was not verified, repeat an identical action, or retry without limit.
//
// Only the external boundaries are stubbed: the AI provider's sendMessage (no network) and
// nothing else - every capability below is offline. global.fetch fails the suite if reached.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEMP_DIRS = [];
for (const [variable, name] of [
  ['RUN_HISTORY_STORE_DIR', 'runs'],
  ['MEMORY_STORE_DIR', 'memory'],
  ['SCHEDULE_STORE_DIR', 'schedules'],
  ['SNAPSHOT_STORE_DIR', 'snapshots'],
  ['CIRCUIT_BREAKER_STORE_DIR', 'circuits'],
  ['VERIFICATION_STORE_DIR', 'verifications'],
  ['APPROVAL_STORE_DIR', 'approvals'],
]) {
  process.env[variable] = fs.mkdtempSync(path.join(os.tmpdir(), `autonomy-learning-${name}-`));
  TEMP_DIRS.push(process.env[variable]);
}
delete process.env.VERCEL;

// Credential canaries in the process environment: nothing below may ever persist them.
const CANARY = 'CANARY-SECRET-DO-NOT-PERSIST-7f3a';
process.env.SHOPIFY_ACCESS_TOKEN = CANARY;
process.env.ANTHROPIC_API_KEY = CANARY;

const BUSINESSES_ROOT = path.join(__dirname, '..', '..', 'configuration', 'businesses');
const FIXTURE_DIRS = [];
function writeBusiness(id) {
  const dir = path.join(BUSINESSES_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'business.yaml'),
    [
      `business_name: "${id}"`,
      'business_model: "D2C"',
      'platform: "Shopify"',
      'product_model: "in-house"',
      'target_markets: ["US"]',
      'countries: ["US"]',
      'currencies: ["USD"]',
      'product_categories: ["home"]',
      'customer_segments: ["homeowners"]',
      'brand:',
      `  name: "${id}"`,
      'business_goals: ["grow"]',
      'marketing_channels: ["email"]',
      'enabled_platforms: [shopify]',
      'autonomy:',
      '  enabled: true',
      '  daily_token_budget: 100000',
      '  approval_ttl_hours: 87600',
      '',
    ].join('\n')
  );
  FIXTURE_DIRS.push(dir);
}
process.on('exit', () => {
  for (const dir of [...FIXTURE_DIRS, ...TEMP_DIRS]) fs.rmSync(dir, { recursive: true, force: true });
});

const LEARN = 'autonomy-learning-listing-co';
const OTHER = 'autonomy-learning-other-co';
const FAIL = 'autonomy-learning-failing-co';
const REPEAT = 'autonomy-learning-repeat-co';
for (const id of [LEARN, OTHER, FAIL, REPEAT]) writeBusiness(id);

const aiProviderSelector = require('../../agent/core/aiProviderSelector');
const { triggerAutonomousCycle } = require('../../autonomy/cycleTrigger');
const { resolveAutonomousApproval, listPendingAutonomousApprovals } = require('../../autonomy/approvalResolution');
const { createBusinessSchedule, setBusinessScheduleEnabled } = require('../../scheduler/scheduleManagement');
const scheduleStore = require('../../scheduler/scheduleStore');
const approvalStore = require('../../approvals/approvalStore');
const executionVerification = require('../../reliability/executionVerification');
const circuitBreaker = require('../../reliability/circuitBreaker');
const runHistoryStore = require('../../agent/core/runHistoryStore');
const { listMemoryRecords } = require('../../agent/core/memoryStore');
const { getRelevantMemoryContext } = require('../../agent/core/memoryContextRetrieval');
const { createEmptyListingContentRecord } = require('../../agent/core/listingContentModel');
const { createEmptySeoResearchRecord } = require('../../agent/core/seoResearchModel');
const { AUTONOMY_KILL_SWITCH_ENV } = require('../../agent/core/autonomyPolicy');
const { signApproval } = require('./approvalSigningTestKey');

process.env[AUTONOMY_KILL_SWITCH_ENV] = 'true';

let passed = 0;
let failed = 0;

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

global.fetch = () => {
  throw new Error('This suite must never make a network call.');
};

const ai = { calls: 0, fail: false };
aiProviderSelector.sendMessage = async () => {
  ai.calls += 1;
  if (ai.fail) throw new Error('The AI provider is unavailable.');
  return { text: 'Review the listing.', model: 'stub-model', stopReason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 } };
};

// --- Fixtures ------------------------------------------------------------------------------
function fullyCoveredListing() {
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
  const keyword = createEmptySeoResearchRecord('insulated hiking jacket');
  keyword.source = ['(placeholder source)'];
  return { listingRecord, keywordRecords: [keyword], factualAttributes: ['waterproof'], customerObjections: ['machine washable'] };
}

const T1 = new Date('2026-03-04T10:07:00.000Z');
const T1_SAME_WINDOW = new Date('2026-03-04T10:41:00.000Z');
const T2 = new Date('2026-03-04T11:07:00.000Z');
const T3 = new Date('2026-03-04T12:07:00.000Z');
const T4 = new Date('2026-03-04T13:07:00.000Z');
const T0 = new Date('2026-03-04T09:07:00.000Z');

const trigger = (businessId, now) => triggerAutonomousCycle({ businessId, now, env: { [AUTONOMY_KILL_SWITCH_ENV]: 'true' } });
const stepOf = (cycle, jobId) => cycle.steps.find((step) => step.job_id === jobId) || {};
const recordOf = (cycle) => runHistoryStore.getRunRecordById(cycle.cycle_id);
const persistedStep = (cycle, jobId) => recordOf(cycle).result.steps.find((step) => step.job_id === jobId) || {};
const memoryFor = (businessId) => listMemoryRecords(businessId, { limit: 100 });
const fieldsPassedTo = (record, toolId) =>
  record.result.audit_trail
    .filter((event) => event.type === 'data_access' && event.tool_id === toolId && event.detail && Array.isArray(event.detail.fields))
    .flatMap((event) => event.detail.fields);

function schedule(businessId, jobId, task) {
  const created = createBusinessSchedule({ businessId, jobId, schedule: { kind: 'interval_minutes', every: 60 }, task, now: T0 });
  assert.strictEqual(created.ok, true, `schedule refused: ${created.reason} ${JSON.stringify(created.errors || [])}`);
  assert.strictEqual(setBusinessScheduleEnabled({ businessId, jobId, enabled: true, now: T0 }).ok, true);
}

function verificationFor(businessId, jobId, occurrenceKey, toolId) {
  const key = executionVerification.computeIdempotencyKey({
    businessId,
    platform: null,
    action: toolId,
    entityKind: 'capability_run',
    entityId: `${jobId}@${occurrenceKey}`,
    expected: null,
  });
  return executionVerification.getVerificationRecord(key, { businessId });
}

function readAllFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readAllFiles(full));
    else out.push(fs.readFileSync(full, 'utf8'));
  }
  return out;
}

(async () => {
  schedule(LEARN, 'audit-listing', { tool_id: 'listing_quality_check', objective: 'Check listing quality for the jacket.', platform: null, params: fullyCoveredListing() });
  schedule(LEARN, 'audit-empty', { tool_id: 'listing_quality_check', objective: 'Check listing quality for the empty draft.', platform: null, params: { listingRecord: createEmptyListingContentRecord('(placeholder) draft') } });

  let t1;
  let t1Occurrence;

  // =========================================================================================
  // EXECUTE -> VERIFY -> AUDIT -> PERSIST -> LEARN
  // =========================================================================================
  await testAsync('a verified result is persisted in run history, the verification store and memory, with its audit trail', async () => {
    t1 = await trigger(LEARN, T1);
    assert.strictEqual(t1.triggered, true, t1.reason);
    assert.strictEqual(stepOf(t1, 'audit-listing').outcome, 'executed', JSON.stringify(stepOf(t1, 'audit-listing')));
    t1Occurrence = scheduleStore.loadScheduledJob('audit-listing', { businessId: LEARN }).last_occurrence_key;

    // Run history: the step and its verification verdict survive the process.
    assert.strictEqual(persistedStep(t1, 'audit-listing').outcome, 'executed');
    assert.strictEqual(persistedStep(t1, 'audit-listing').verification, 'verified');

    // Verification store: the completion is on disk under the job's own key.
    const verification = verificationFor(LEARN, 'audit-listing', t1Occurrence, 'listing_quality_check');
    assert.ok(verification, 'a verification record was written');
    assert.strictEqual(verification.status, 'verified');
    assert.strictEqual(verification.business_id, LEARN);

    // Audit: execution, validation and the memory write are all traceable.
    const summaries = recordOf(t1).result.audit_trail.map((event) => event.summary);
    assert.ok(summaries.includes("'listing_quality_check' completed and its result passed validation."));
    assert.ok(summaries.includes(`Saved a reusable finding to memory for business '${LEARN}'.`));

    // Memory: exactly one record, verified, sourced to this cycle and job.
    const saved = memoryFor(LEARN).filter((entry) => entry.source && entry.source.job_id === 'audit-listing');
    assert.strictEqual(saved.length, 1);
    assert.strictEqual(saved[0].verification_status, 'passed');
    assert.strictEqual(saved[0].source.run_id, t1.cycle_id);
    assert.strictEqual(saved[0].source.tool_id, 'listing_quality_check');
  });

  await testAsync('an empty or partial result is persisted as unverifiable and is never learned', async () => {
    assert.strictEqual(stepOf(t1, 'audit-empty').outcome, 'verification_failed', JSON.stringify(stepOf(t1, 'audit-empty')));
    assert.strictEqual(persistedStep(t1, 'audit-empty').verification, 'unverifiable');
    const occurrence = scheduleStore.loadScheduledJob('audit-empty', { businessId: LEARN }).last_occurrence_key;
    assert.strictEqual(verificationFor(LEARN, 'audit-empty', occurrence, 'listing_quality_check').status, 'unverifiable');
    assert.ok(!memoryFor(LEARN).some((entry) => entry.source && entry.source.job_id === 'audit-empty'), 'nothing unverified is remembered');
  });

  await testAsync('no fabricated learning: memory holds only the Chief summary of verified work', async () => {
    const records = memoryFor(LEARN);
    assert.strictEqual(records.length, 1, JSON.stringify(records.map((entry) => entry.source)));
    for (const record of records) {
      assert.strictEqual(record.verification_status, 'passed');
      assert.strictEqual(record.priority_id, 'reusable_findings');
      assert.ok(record.summary.length > 0 && record.summary.length <= 600);
    }
  });

  // =========================================================================================
  // NEXT CYCLE
  // =========================================================================================
  await testAsync('the next cycle receives what the previous one verified, and does not repeat work in the same window', async () => {
    const same = await trigger(LEARN, T1_SAME_WINDOW);
    assert.strictEqual(same.considered, 0, 'an occurrence is claimed once');

    const t2 = await trigger(LEARN, T2);
    assert.strictEqual(stepOf(t2, 'audit-listing').outcome, 'executed');
    assert.ok(fieldsPassedTo(recordOf(t2), 'listing_quality_check').includes('relevant_memory'), 'the verified finding from the previous cycle reached the capability');
  });

  await testAsync('a restored schedule that replays a verified occurrence is refused by the verification store', async () => {
    const job = scheduleStore.loadScheduledJob('audit-listing', { businessId: LEARN });
    scheduleStore.saveScheduledJob({ ...job, last_occurrence_key: null });
    const memoryBefore = memoryFor(LEARN).length;

    const replay = await trigger(LEARN, T1);
    const step = stepOf(replay, 'audit-listing');
    assert.strictEqual(step.outcome, 'blocked', JSON.stringify(step));
    assert.strictEqual(step.reason_code, 'already_completed');
    assert.strictEqual(memoryFor(LEARN).length, memoryBefore, 'a replay learns nothing twice');
  });

  await testAsync('no cross-business leakage: another business sees none of this memory or verification state', async () => {
    assert.strictEqual(memoryFor(OTHER).length, 0);
    assert.deepStrictEqual(getRelevantMemoryContext(OTHER), {});
    assert.strictEqual(verificationFor(OTHER, 'audit-listing', t1Occurrence, 'listing_quality_check'), null);
    assert.ok(!runHistoryStore.listRunRecordSummaries({ limit: 200, businessId: OTHER }).some((run) => run.business_id === LEARN));
  });

  // =========================================================================================
  // FAILED RESULTS, AND NO UNCONTROLLED RETRY
  // =========================================================================================
  await testAsync('a failed execution is persisted as failed, never learned, and retried only on later occurrences until the breaker opens', async () => {
    schedule(FAIL, 'recommend', { tool_id: 'ai_reasoning_completion', objective: 'Recommend what the owner should review this week.', platform: null });
    ai.fail = true;
    try {
      const callsPerOccurrence = [];
      for (const now of [T1, T2, T3]) {
        const before = ai.calls;
        const cycle = await trigger(FAIL, now);
        const step = stepOf(cycle, 'recommend');
        assert.ok(['execution_failed', 'verification_failed'].includes(step.outcome), JSON.stringify(step));
        const occurrence = scheduleStore.loadScheduledJob('recommend', { businessId: FAIL }).last_occurrence_key;
        const verification = verificationFor(FAIL, 'recommend', occurrence, 'ai_reasoning_completion');
        assert.ok(verification && verification.status !== 'verified', 'a failure is recorded, never as verified');
        assert.strictEqual(persistedStep(cycle, 'recommend').verification, verification.status);
        callsPerOccurrence.push(ai.calls - before);

        const again = await trigger(FAIL, new Date(now.getTime() + 20 * 60 * 1000));
        assert.strictEqual(again.considered, 0, 'a failed occurrence is not retried inside its own window');
      }
      assert.ok(!memoryFor(FAIL).length, 'nothing failed is remembered');

      // Three consecutive failures open the breaker: inside its cooldown nothing may run.
      const scope = { businessId: FAIL, platform: null, action: 'ai_reasoning_completion' };
      const whileOpen = circuitBreaker.checkCircuit({ ...scope, now: new Date(T3.getTime() + 10 * 60 * 1000) });
      assert.strictEqual(whileOpen.allowed, false);
      assert.strictEqual(whileOpen.reason_code, 'circuit_open');

      // After the cooldown the breaker permits exactly ONE trial; its failure reopens it.
      const trial = await trigger(FAIL, T4);
      assert.strictEqual(stepOf(trial, 'recommend').outcome, 'execution_failed', JSON.stringify(stepOf(trial, 'recommend')));
      const reopened = circuitBreaker.checkCircuit({ ...scope, now: new Date(T4.getTime() + 10 * 60 * 1000) });
      assert.strictEqual(reopened.allowed, false, 'a failed trial closes the gate again for a fresh cooldown');
      assert.strictEqual(reopened.reason_code, 'circuit_open');
      assert.ok(callsPerOccurrence.every((count) => count <= 3), `bounded attempts per occurrence: ${callsPerOccurrence}`);
    } finally {
      ai.fail = false;
    }
  });

  // =========================================================================================
  // NO REPEATED IDENTICAL ACTION WITHOUT REASON
  // =========================================================================================
  await testAsync('an identical consequential action still pending is not queued again; once decided, a later occurrence may ask again', async () => {
    const vendor = { content: 'Aurora Ceramics', productId: 'gid://shopify/Product/1', newVendor: 'Aurora Ceramics' };
    schedule(REPEAT, 'fix-vendor', { tool_id: 'shopify_vendor_correction', objective: 'Correct the vendor on the product.', platform: 'shopify', params: vendor });

    const first = await trigger(REPEAT, T1);
    assert.strictEqual(stepOf(first, 'fix-vendor').outcome, 'approval_required', JSON.stringify(stepOf(first, 'fix-vendor')));
    const firstId = stepOf(first, 'fix-vendor').approval_request_id;

    const second = await trigger(REPEAT, T2);
    const repeated = stepOf(second, 'fix-vendor');
    assert.strictEqual(repeated.outcome, 'approval_required');
    assert.strictEqual(repeated.reason_code, 'approval_already_pending');
    assert.strictEqual(repeated.approval_request_id, firstId, 'the owner is pointed at the approval already waiting');
    assert.strictEqual(listPendingAutonomousApprovals({ businessId: REPEAT }).length, 1);
    assert.ok(recordOf(second).result.audit_trail.some((event) => /identical action was not queued again/.test(event.summary)));

    const record = approvalStore.loadApprovalRecord(firstId, { expectedBusinessId: REPEAT }).approval_request;
    const rejected = await resolveAutonomousApproval({ approvalId: firstId, businessId: REPEAT, decision: 'rejected', decidedBy: 'owner@example.com', authorization: signApproval({ request: record, decision: 'rejected', decidedBy: 'owner@example.com' }) });
    assert.strictEqual(rejected.ok, true, rejected.reason);

    const third = await trigger(REPEAT, T3);
    assert.strictEqual(stepOf(third, 'fix-vendor').outcome, 'approval_required');
    assert.notStrictEqual(stepOf(third, 'fix-vendor').reason_code, 'approval_already_pending');
    assert.strictEqual(listPendingAutonomousApprovals({ businessId: REPEAT }).length, 1);

    // A different action for the same tool is never mistaken for a duplicate.
    const pendingId = listPendingAutonomousApprovals({ businessId: REPEAT })[0].approval_id;
    assert.notStrictEqual(pendingId, firstId);
  });

  // =========================================================================================
  // NO CREDENTIALS
  // =========================================================================================
  await testAsync('no credential from the environment is persisted in any store the loop wrote', async () => {
    const contents = TEMP_DIRS.flatMap((dir) => readAllFiles(dir));
    assert.ok(contents.length > 0, 'the loop wrote real state');
    assert.ok(!contents.some((content) => content.includes(CANARY)));
  });

  await testAsync('this test file is registered in the suite runner', async () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('autonomyLearningLoop.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
