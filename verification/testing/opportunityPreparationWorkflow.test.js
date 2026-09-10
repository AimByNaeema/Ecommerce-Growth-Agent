'use strict';

// The opportunity -> validation -> SEO -> listing draft -> compliance -> approval workflow.
//
// WHAT THESE TESTS EXIST TO PIN. This workflow's whole purpose is to stop in the right
// place. So the tests are weighted toward what must NOT happen: no marketplace write, no
// Etsy write scope, no fabricated product fact, no compliance bypass, and no second
// orchestration engine. A test that only proved the happy path would miss all of it.
//
// NO NETWORK. Every stage runs through the real engine against the real registry with
// caller-supplied evidence only. Nothing here reaches Shopify, Etsy or a model API.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.RUN_HISTORY_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opp-prep-test-'));

const workflow = require('../../agent/core/opportunityPreparationWorkflow');
const growthWorkflowOrchestrator = require('../../agent/core/growthWorkflowOrchestrator');
const commandCenterSession = require('../../agent/core/commandCenterSession');
const { createEmptyCommandCenterSession, validateCommandCenterSessionShape } = require('../../agent/core/commandCenterSessionModel');
const { TOOL_REGISTRY } = require('../../tools/toolRegistry');
const etsyClient = require('../../integrations/adapters/etsyClient');
const etsyReadClient = require('../../integrations/adapters/etsyReadClient');
const { ACTION_CLASSIFICATIONS } = require('../../approvals/approvalArchitecture');

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

// One opportunity shaped like the real pipeline's output.
function opportunity(overrides = {}) {
  return Object.assign(
    {
      rank: 1,
      product: 'Monogram Alphabet Font Bundle',
      market: 'digital font bundles',
      customer_fit_reason: 'Overlaps the monogram and font products this store already sells.',
      demand: { assessment: 'Steady interest reported.', source: ['https://example.test/demand'], confidence: 'low' },
      competition: { assessment: 'Established sellers dominate.', source: ['https://example.test/comp'], confidence: 'low' },
      scores: { evidence_coverage: 100 },
      compliance: { status: 'PASS' },
      evidence: [{ source_url: 'https://example.test/demand' }, { source_url: 'https://example.test/comp' }],
    },
    overrides
  );
}

function snapshotOf(opp) {
  return workflow.buildOpportunitySnapshot(opp, { sessionId: 'sess-test', runId: 'run-test' });
}

(async () => {
  // -------------------------------------------------------------------------------------
  // 1. It is not a second orchestrator - it supplies stages to the EXISTING engine.
  // -------------------------------------------------------------------------------------

  test('the workflow file contains no dispatch logic of its own', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../agent/core/opportunityPreparationWorkflow.js'), 'utf8');
    // Strip line comments so the prose above can discuss what the code must not do.
    const code = source
      .split('\n')
      .map((line) => line.replace(/\r$/, '').replace(/^\s*\/\/.*$/, ''))
      .join('\n');
    for (const forbidden of ['buildPlanStep', 'planRouting', 'runOrchestratorContract', 'scoreRoutingTargets', 'TOOL_REGISTRY']) {
      assert.ok(!code.includes(forbidden), `opportunityPreparationWorkflow.js must not call ${forbidden} - the existing engine does`);
    }
    assert.ok(code.includes('runGrowthWorkflow'), 'it must delegate to the existing growth workflow engine');
  });

  test('every stage names a real specialist and pins a real tool + capability', () => {
    const toolIds = new Set(TOOL_REGISTRY.map((t) => t.id));
    assert.strictEqual(workflow.OPPORTUNITY_PREPARATION_STAGES.length, 3);
    for (const stage of workflow.OPPORTUNITY_PREPARATION_STAGES) {
      assert.ok(stage.forcedSelection, `${stage.key} must pin its tool explicitly, not rely on word overlap`);
      assert.ok(toolIds.has(stage.forcedSelection.toolId), `${stage.key} names an unregistered tool: ${stage.forcedSelection.toolId}`);
      assert.ok(typeof stage.forcedSelection.capabilityId === 'string' && stage.forcedSelection.capabilityId !== '');
      assert.ok(typeof stage.specialistId === 'string' && stage.specialistId !== '');
    }
  });

  test('SEO runs before the listing draft, so the draft can use the SEO result', () => {
    assert.deepStrictEqual(workflow.STAGE_KEYS, ['validation', 'seo', 'listing']);
  });

  test('the default growth workflow is unchanged by the stage list becoming injectable', () => {
    // The engine's own default must still be its own 8 stages, in its own order. Making the
    // list injectable must not have edited the list it defaults to.
    const stages = growthWorkflowOrchestrator.STAGE_DEFINITIONS;
    assert.deepStrictEqual(
      stages.map((s) => s.key),
      ['research', 'product', 'listing', 'seo', 'marketing', 'social_advertising', 'analytics', 'optimization'],
      "the growth workflow's own stage list must be untouched"
    );
    // Its order is genuinely different from this workflow's - the growth workflow runs
    // listing before seo, this one runs seo before listing. Both are correct for their own
    // purpose, and neither may be quietly changed to match the other.
    assert.ok(stages.findIndex((s) => s.key === 'listing') < stages.findIndex((s) => s.key === 'seo'));
    assert.ok(workflow.STAGE_KEYS.indexOf('seo') < workflow.STAGE_KEYS.indexOf('listing'));
  });

  // -------------------------------------------------------------------------------------
  // 2. No publish path exists - structurally, not by promise.
  // -------------------------------------------------------------------------------------

  test('the workflow declares no PUBLISHED or PUBLISH_AUTHORIZED state', () => {
    for (const forbidden of ['PUBLISHED', 'PUBLISH_AUTHORIZED', 'PUBLISHING']) {
      assert.ok(!workflow.WORKFLOW_STATES.includes(forbidden), `${forbidden} must not be reachable from this workflow`);
    }
    assert.ok(workflow.WORKFLOW_STATES.includes('AWAITING_APPROVAL'), 'AWAITING_APPROVAL is where it must stop');
  });

  test('no stage tool is a marketplace-writing tool', () => {
    for (const stage of workflow.OPPORTUNITY_PREPARATION_STAGES) {
      const tool = TOOL_REGISTRY.find((t) => t.id === stage.forcedSelection.toolId);
      assert.ok(tool, `${stage.forcedSelection.toolId} is not registered`);
      assert.strictEqual(tool.status, 'implemented', `${tool.id} must be a real implemented tool`);
      assert.ok(
        !/shopify|etsy|publish|marketplace/i.test(tool.id),
        `${tool.id} looks like a marketplace tool - no stage may reach one`
      );
    }
  });

  // The registry's `operation` field describes what a tool produces (listing_content_generation
  // is 'write' because it composes content), NOT whether it can act externally. The binding
  // control is the APPROVAL CLASSIFICATION the orchestrator applies at execution time, which
  // is what this asserts - read from the run's own audit trail, not from a constant.
  await testAsync('every stage actually executed as analysis_only, gated by nothing', async () => {
    const result = await workflow.prepareOpportunity({ opportunity: opportunity(), sessionId: 'sess-test', runId: 'run-test' });
    const entries = (result.audit_trail || []).filter((e) => e.tool_id && e.classification);
    assert.ok(entries.length > 0, 'the run must have produced a real audit trail');
    const toolIds = new Set(entries.map((e) => e.tool_id));
    for (const stage of workflow.OPPORTUNITY_PREPARATION_STAGES) {
      assert.ok(toolIds.has(stage.forcedSelection.toolId), `${stage.forcedSelection.toolId} did not appear in the audit trail`);
    }
    for (const entry of entries) {
      assert.strictEqual(
        entry.classification,
        'analysis_only',
        `${entry.tool_id} executed as ${entry.classification} - a stage that could act externally does not belong in this workflow`
      );
    }
  });

  test('every Etsy tool in the registry is read-only', () => {
    const etsyTools = TOOL_REGISTRY.filter((t) => /etsy/i.test(t.id));
    assert.ok(etsyTools.length > 0, 'the Etsy read tools should be registered');
    for (const tool of etsyTools) {
      assert.strictEqual(tool.operation, 'read', `${tool.id} must be operation:read - no Etsy write tool may exist`);
    }
    // And no tool of any name is an Etsy publisher.
    const publishers = TOOL_REGISTRY.filter((t) => /etsy/i.test(t.id) && /publish|upload|listing_create|listing_update/i.test(t.id));
    assert.deepStrictEqual(publishers.map((t) => t.id), []);
  });

  test('Etsy publishing is closed at the client, and the read client is GET-only', () => {
    assert.strictEqual(etsyClient.canPublish(), false, 'etsyClient.canPublish() must be false');
    const source = fs.readFileSync(path.join(__dirname, '../../integrations/adapters/etsyReadClient.js'), 'utf8');
    assert.ok(!/listings_w|shops_w|transactions_w|feedback_w/.test(source), 'no Etsy write scope may appear in the read client');
    assert.ok(typeof etsyReadClient.canRead === 'function');
  });

  test('this workflow adds no Etsy write scope anywhere', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../agent/core/opportunityPreparationWorkflow.js'), 'utf8');
    assert.ok(!/listings_w|shops_w|transactions_w|billing_w|feedback_w/.test(source));
  });

  // -------------------------------------------------------------------------------------
  // 3. Compliance can never be bypassed.
  // -------------------------------------------------------------------------------------

  await testAsync('an opportunity the research already BLOCKED never runs a single stage', async () => {
    let called = 0;
    const result = await workflow.prepareOpportunity({
      opportunity: opportunity({ compliance: { status: 'BLOCK', review_reasons: ['protected mark'] } }),
      sessionId: 'sess-test',
      runId: 'run-test',
      runWorkflow: async () => {
        called += 1;
        return { plan: [] };
      },
    });
    assert.strictEqual(result.state, 'COMPLIANCE_BLOCKED');
    assert.strictEqual(called, 0, 'no stage may run for an already-blocked opportunity - and no tokens spent');
    assert.strictEqual(result.approval, null, 'a blocked opportunity must never produce an approval request');
  });

  await testAsync('a protected mark in the product name is a BLOCK, not a REVIEW', async () => {
    for (const product of ['Star Wars Alphabet Bundle', 'Disney Princess Font Pack']) {
      const result = await workflow.prepareOpportunity({
        opportunity: opportunity({ product, compliance: { status: 'PASS' } }),
        sessionId: 'sess-test',
        runId: 'run-test',
      });
      assert.strictEqual(result.compliance.status, 'BLOCK', `${product} must be BLOCKed by the protected-mark pass`);
      assert.strictEqual(result.state, 'COMPLIANCE_BLOCKED');
      assert.strictEqual(result.approval, null, `${product} must not reach an approval request`);
    }
  });

  test('the protected-mark pass reuses the existing detector rather than a second list', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../agent/core/opportunityPreparationWorkflow.js'), 'utf8');
    assert.ok(source.includes("require('../../compliance/etsyIpRiskDetector')"), 'it must reuse compliance/etsyIpRiskDetector.js');
    assert.ok(!/PROTECTED_MARK_INDICATORS\s*=/.test(source), 'it must not define its own mark list');
    assert.ok(source.includes("require('../../compliance/complianceEngine')"), 'it must reuse the existing compliance engine');
  });

  test('the compliance gate checks the product name, not only generated copy', () => {
    const blocked = workflow.checkDraftCompliance(snapshotOf(opportunity({ product: 'Star Wars Font' })), '');
    assert.strictEqual(blocked.status, 'BLOCK', 'a mark in the product name must be caught even with an empty draft');
  });

  test('nothing is reworded to make a verdict pass', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../agent/core/opportunityPreparationWorkflow.js'), 'utf8');
    // The product name reaches compliance verbatim from the snapshot; there is no
    // substitution/sanitisation step anywhere between the record and the checker.
    assert.ok(!/\.replace\(/.test(source.split('function checkDraftCompliance')[1].split('\n}')[0] || ''), 'checkDraftCompliance must not rewrite content');
    const snapshot = snapshotOf(opportunity({ product: 'Star Wars Font' }));
    assert.strictEqual(snapshot.product, 'Star Wars Font', 'the product name must reach compliance exactly as recorded');
  });

  // -------------------------------------------------------------------------------------
  // 4. Nothing is invented.
  // -------------------------------------------------------------------------------------

  test('every required listing fact is reported missing unless the record establishes it', () => {
    const missing = workflow.collectMissingFacts(opportunity());
    assert.deepStrictEqual(missing, workflow.REQUIRED_LISTING_FACTS, 'market research establishes none of these');
    for (const fact of ['file_formats', 'file_count', 'dimensions', 'editable_where', 'personalization', 'delivery_method', 'turnaround_time', 'licence']) {
      assert.ok(workflow.REQUIRED_LISTING_FACTS.includes(fact), `${fact} must be a required listing fact`);
    }
  });

  test('a fact the record DOES establish is not reported missing', () => {
    const missing = workflow.collectMissingFacts(opportunity({ facts: { file_formats: 'OTF, TTF', licence: 'Commercial' } }));
    assert.ok(!missing.includes('file_formats'));
    assert.ok(!missing.includes('licence'));
    assert.ok(missing.includes('file_count'), 'an unestablished fact stays missing');
  });

  test('stage evidence carries only what the opportunity recorded, each naming its run', () => {
    const evidence = workflow.buildStageEvidence(snapshotOf(opportunity()));
    assert.ok(evidence.length > 0);
    for (const entry of evidence) {
      assert.ok(typeof entry.topic === 'string' && entry.topic !== '', 'each evidence record needs a topic');
      assert.ok(typeof entry.finding === 'string' && entry.finding !== '');
      assert.ok(Array.isArray(entry.source) && entry.source.length > 0);
      assert.ok(entry.source.every((s) => /run-test/.test(s)), 'each evidence record must name the real research run');
    }
  });

  test('an opportunity with no recorded signals produces no invented evidence', () => {
    const bare = { rank: 9, product: 'Plain Planner' };
    const evidence = workflow.buildStageEvidence(workflow.buildOpportunitySnapshot(bare, {}));
    assert.deepStrictEqual(evidence, [], 'nothing recorded means nothing supplied');
    assert.deepStrictEqual(workflow.buildValidationDimensions(bare, workflow.buildOpportunitySnapshot(bare, {})), {});
  });

  test('validation dimensions relay the research confidence verbatim and invent none', () => {
    const opp = opportunity();
    const params = workflow.buildValidationDimensions(opp, snapshotOf(opp));
    assert.strictEqual(params.demandConfidence, 'low', "the research's own confidence, unchanged");
    assert.strictEqual(params.competitionConfidence, 'low');
    assert.ok(!('marketFitConfidence' in params), 'the research stated no market-fit confidence, so none may be supplied');
    assert.ok(!('productRiskAssessment' in params), 'the research assessed no product risk, so none may be supplied');
  });

  test('a signal with no assessment is not relayed at all', () => {
    const opp = opportunity({ demand: { source: ['https://example.test/x'], confidence: 'high' } });
    const params = workflow.buildValidationDimensions(opp, snapshotOf(opp));
    assert.ok(!('demandAssessment' in params));
    assert.ok(!('demandEvidence' in params), 'evidence without an assessment must not be relayed as if assessed');
  });

  test('validation evidence is shaped as the engine requires, not as bare URLs', () => {
    const opp = opportunity();
    const params = workflow.buildValidationDimensions(opp, snapshotOf(opp));
    assert.ok(Array.isArray(params.demandEvidence));
    for (const record of params.demandEvidence) {
      assert.ok(typeof record === 'object' && record !== null, 'a bare URL string is rejected by retrieveResearchData');
      assert.ok(typeof record.topic === 'string' && record.topic !== '');
      assert.ok(Array.isArray(record.source));
    }
  });

  // -------------------------------------------------------------------------------------
  // 5. End to end, through the real engine.
  // -------------------------------------------------------------------------------------

  await testAsync('a clean opportunity reaches AWAITING_APPROVAL with all three stages run', async () => {
    const result = await workflow.prepareOpportunity({ opportunity: opportunity(), sessionId: 'sess-test', runId: 'run-test' });
    assert.strictEqual(result.state, 'AWAITING_APPROVAL');
    for (const key of workflow.STAGE_KEYS) {
      assert.ok(result.stages[key], `${key} must be present`);
      assert.ok(result.stages[key].status !== null, `${key} must report a real status`);
      assert.notStrictEqual(result.stages[key].status, 'failed', `${key} must not fail: ${JSON.stringify(result.stages[key].status)}`);
    }
    assert.ok(result.workflow_run_id, 'the run must be recorded under a real id');
  });

  await testAsync('product validation actually runs and returns a real scored result', async () => {
    const result = await workflow.prepareOpportunity({ opportunity: opportunity(), sessionId: 'sess-test', runId: 'run-test' });
    const scoring = result.stages.validation.result && result.stages.validation.result.opportunity_scoring;
    assert.ok(scoring, 'the validation stage must return a real opportunity_scoring block');
    assert.strictEqual(scoring.dimensions_total, 4);
    // The two dimensions the research actually assessed - and only those.
    assert.deepStrictEqual(scoring.dimensions_evidence_backed_ids, ['demand', 'competition']);
    assert.strictEqual(scoring.status, 'partial', 'a partially-evidenced validation must say so, not claim success');
  });

  await testAsync('the approval request is real, pending, and states that nothing was published', async () => {
    const requests = [];
    const result = await workflow.prepareOpportunity({
      opportunity: opportunity(),
      sessionId: 'sess-test',
      runId: 'run-test',
      approvalRequests: requests,
    });
    const approval = result.approval;
    assert.ok(approval, 'an approval request must be created');
    assert.strictEqual(approval.status, 'pending');
    assert.ok(
      ACTION_CLASSIFICATIONS.some((c) => c.id === approval.classification),
      `${approval.classification} must be one of the existing 4 classes`
    );
    assert.strictEqual(approval.classification, 'approval_required');
    assert.ok(/nothing has been written to any marketplace/i.test(approval.reason));
    assert.strictEqual(requests.length, 1, 'the request must be recorded in the caller\'s list');
  });

  await testAsync('an opportunity whose facts were never established stops at NEEDS_INFORMATION', async () => {
    const result = await workflow.prepareOpportunity({
      // No customer_fit_reason, so the listing tool has nothing real to compose from.
      opportunity: { rank: 7, product: 'Plain Digital Planner', market: 'planners', evidence: [], compliance: { status: 'PASS' } },
      sessionId: 'sess-test',
      runId: 'run-test',
    });
    assert.strictEqual(result.state, 'NEEDS_INFORMATION');
    assert.strictEqual(result.approval, null, 'a human must not be asked to approve a blank draft');
    assert.ok(result.missing_information.length > 0);
    assert.ok(result.limitations.some((l) => /No reviewable listing draft could be composed/i.test(l)));
  });

  await testAsync('the draft is read from specialized_records, so compliance sees real text', async () => {
    const result = await workflow.prepareOpportunity({ opportunity: opportunity(), sessionId: 'sess-test', runId: 'run-test' });
    assert.ok(result.draft, 'the draft record itself must be returned, not the tool envelope');
    assert.ok('product_title' in result.draft, 'the draft must be the listing content record');
    assert.ok(!('findings' in result.draft), 'the tool envelope must not be mistaken for the draft');
  });

  // -------------------------------------------------------------------------------------
  // 6. Channel is stated, never inferred.
  // -------------------------------------------------------------------------------------

  test('an opportunity with no stated channel stays null - never defaulted to Shopify', () => {
    const snapshot = snapshotOf(opportunity());
    assert.strictEqual(snapshot.channel, null);
    assert.strictEqual(snapshot.channel_reference, null);
  });

  test('a product name mentioning a marketplace does not become that channel', () => {
    const snapshot = snapshotOf(opportunity({ product: 'Etsy-style Shop Banner Kit for Shopify sellers' }));
    assert.strictEqual(snapshot.channel, null, 'channel must never be inferred from a product name');
  });

  await testAsync('an Etsy opportunity reaches AWAITING_APPROVAL carrying an explicit read-only warning', async () => {
    const result = await workflow.prepareOpportunity({
      opportunity: opportunity({ channel: 'etsy' }),
      sessionId: 'sess-test',
      runId: 'run-test',
    });
    assert.strictEqual(result.state, 'AWAITING_APPROVAL', 'it stops here - it can never reach a publish state');
    assert.strictEqual(result.opportunity.channel, 'etsy');
    const warnings = result.approval.execution_request.research_params.warnings;
    assert.ok(warnings.some((w) => /read-only/i.test(w) && /cannot be published/i.test(w)));
  });

  await testAsync('a Shopify-channel opportunity carries no false Etsy warning', async () => {
    const result = await workflow.prepareOpportunity({
      opportunity: opportunity({ channel: 'shopify' }),
      sessionId: 'sess-test',
      runId: 'run-test',
    });
    assert.deepStrictEqual(result.approval.execution_request.research_params.warnings, []);
  });

  // -------------------------------------------------------------------------------------
  // 7. No credential can reach a session, an approval, or a snapshot.
  // -------------------------------------------------------------------------------------

  await testAsync('nothing the workflow returns matches a credential pattern', async () => {
    const result = await workflow.prepareOpportunity({ opportunity: opportunity(), sessionId: 'sess-test', runId: 'run-test' });
    const serialized = JSON.stringify(result);
    for (const pattern of [/"access_token"/i, /"refresh_token"/i, /"api_key"/i, /"client_secret"/i, /keystring/i]) {
      assert.ok(!pattern.test(serialized), `a credential-shaped key reached the workflow output: ${pattern}`);
    }
  });

  test('a session carrying an opportunity workflow still validates', () => {
    const session = createEmptyCommandCenterSession({ session_id: 'sess-test' });
    session.opportunity_workflows = [
      {
        ref: 1,
        product: 'Monogram Alphabet Font Bundle',
        state: 'AWAITING_APPROVAL',
        compliance_status: 'PASS',
        channel: null,
        channel_reference: null,
        stages: { validation: 'blocked', seo: 'complete', listing: 'complete' },
        approval_id: 'apr-opportunity-sess-test-1-1',
        approval_status: 'pending',
        missing_information: ['file_formats'],
        run_id: 'opportunity-prep-1',
        at: '2026-09-10T00:00:00.000Z',
      },
    ];
    const check = validateCommandCenterSessionShape(session);
    assert.ok(check.valid, `session should validate: ${check.errors.join('; ')}`);
  });

  test('opportunity_workflows is part of the session schema and starts empty', () => {
    const session = createEmptyCommandCenterSession({ session_id: 's' });
    assert.deepStrictEqual(session.opportunity_workflows, []);
    const broken = createEmptyCommandCenterSession({ session_id: 's' });
    broken.opportunity_workflows = 'not-an-array';
    assert.ok(!validateCommandCenterSessionShape(broken).valid);
  });

  // -------------------------------------------------------------------------------------
  // 8. The session layer: an ordinal resolves, a recall re-runs nothing.
  // -------------------------------------------------------------------------------------

  function sessionWithResult() {
    const session = createEmptyCommandCenterSession({ session_id: 'sess-test' });
    session.original_goal = 'Find products we could sell next.';
    session.specialist_results = [
      { ref: 1, label: 'Monogram Alphabet Font Bundle', specialist: 'research', run_id: 'run-test', channel: null, channel_reference: null, summary: '', payload_ref: null },
    ];
    session.run_refs = ['run-test'];
    return session;
  }

  const RUN_RECORD = {
    run_id: 'run-test',
    result: {
      routing: {
        plan: [{ outputs: { result: { top_opportunities: [opportunity()] } } }],
      },
    },
  };

  await testAsync('"prepare the first opportunity" resolves the ordinal and prepares #1', async () => {
    let prepared = 0;
    const outcome = await commandCenterSession.runSessionTurn(sessionWithResult(), 'Please prepare the first opportunity for listing.', {
      sessionDir: process.env.RUN_HISTORY_STORE_DIR,
      loadRunRecord: () => RUN_RECORD,
      runChief: async () => {
        throw new Error('the Chief must not be called for a preparation turn');
      },
      runPreparation: async ({ opportunity: opp }) => {
        prepared += 1;
        assert.strictEqual(opp.product, 'Monogram Alphabet Font Bundle', 'the ordinal must resolve to the recorded result');
        return {
          state: 'AWAITING_APPROVAL',
          opportunity: workflow.buildOpportunitySnapshot(opp, { sessionId: 'sess-test', runId: 'run-test' }),
          stages: { validation: { status: 'blocked' }, seo: { status: 'complete' }, listing: { status: 'complete' } },
          compliance: { status: 'PASS' },
          approval: { id: 'apr-1', status: 'pending' },
          missing_information: ['file_formats'],
          limitations: [],
          workflow_run_id: 'opportunity-prep-1',
        };
      },
    });
    assert.strictEqual(prepared, 1, 'the preparation must run exactly once');
    assert.strictEqual(outcome.session.opportunity_workflows.length, 1);
    assert.strictEqual(outcome.session.opportunity_workflows[0].ref, 1);
    assert.strictEqual(outcome.session.status, 'waiting_for_approval');
    assert.strictEqual(outcome.session.pending_items[0].kind, 'approval');
  });

  await testAsync('"show me the draft" re-runs nothing at all', async () => {
    const session = sessionWithResult();
    session.opportunity_workflows = [
      {
        ref: 1,
        product: 'Monogram Alphabet Font Bundle',
        state: 'AWAITING_APPROVAL',
        compliance_status: 'PASS',
        channel: null,
        channel_reference: null,
        stages: { validation: 'blocked', seo: 'complete', listing: 'complete' },
        approval_id: 'apr-1',
        approval_status: 'pending',
        missing_information: ['file_formats'],
        run_id: 'opportunity-prep-1',
        at: '2026-09-10T00:00:00.000Z',
      },
    ];
    let chiefCalls = 0;
    let prepCalls = 0;
    const outcome = await commandCenterSession.runSessionTurn(session, 'Show me the draft.', {
      sessionDir: process.env.RUN_HISTORY_STORE_DIR,
      loadRunRecord: () => RUN_RECORD,
      runChief: async () => {
        chiefCalls += 1;
        return {};
      },
      runPreparation: async () => {
        prepCalls += 1;
        return {};
      },
    });
    assert.strictEqual(chiefCalls, 0, 'a recall must not call the Chief');
    assert.strictEqual(prepCalls, 0, 'a recall must not re-run the preparation');
    assert.ok(outcome.recalled, 'the stored workflow must be what is reported back');
    assert.ok(/AWAITING_APPROVAL/.test(outcome.session.messages[outcome.session.messages.length - 1].text));
  });

  await testAsync('a blocked preparation offers no draft-viewing next action', async () => {
    const outcome = await commandCenterSession.runSessionTurn(sessionWithResult(), 'Prepare the first opportunity for listing.', {
      sessionDir: process.env.RUN_HISTORY_STORE_DIR,
      loadRunRecord: () => RUN_RECORD,
      runChief: async () => ({}),
      runPreparation: async ({ opportunity: opp }) => ({
        state: 'COMPLIANCE_BLOCKED',
        opportunity: workflow.buildOpportunitySnapshot(opp, {}),
        stages: {},
        compliance: { status: 'BLOCK' },
        approval: null,
        missing_information: [],
        limitations: ['blocked'],
        workflow_run_id: null,
      }),
    });
    const actions = outcome.session.next_actions;
    assert.ok(!actions.some((a) => a.id === 'view_draft'), 'no next action may claim a draft that was never written');
    assert.strictEqual(actions[0].id, 'view_compliance');
    assert.ok(/no listing draft was prepared/i.test(actions[0].basis));
  });

  // -------------------------------------------------------------------------------------
  // 9. The UI shows progress and offers no publish control.
  // -------------------------------------------------------------------------------------

  test('the dashboard renders the workflow with no publish or apply control', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../public/dashboard.js'), 'utf8');
    const start = source.indexOf('function renderOpportunityWorkflows');
    assert.ok(start > -1, 'renderOpportunityWorkflows must exist');
    const region = source.slice(start, source.indexOf('function workflowStateClass'));
    // A control, not a word: no button/anchor is created, and nothing is wired to a click.
    assert.ok(!/createElement\(\s*['"](button|a|form|input)['"]\s*\)/i.test(region), 'the workflow card must create no clickable control');
    assert.ok(!/addEventListener|onclick|apiFetch|fetch\(/.test(region), 'the workflow card must trigger no action at all - it only renders state');
    assert.ok(/Read-only — publishing unavailable/.test(region), 'an Etsy workflow must say publishing is unavailable');
    assert.ok(/cannot be published to Etsy/.test(region), 'it must say plainly that publishing cannot happen from here');
  });

  test('the workflow card renders only the six real steps', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../public/dashboard.js'), 'utf8');
    const start = source.indexOf('function workflowStepValues');
    const region = source.slice(start, source.indexOf('function renderOpportunityWorkflows'));
    for (const label of ['Opportunity', 'Validation', 'Compliance', 'SEO', 'Listing draft', 'Approval']) {
      assert.ok(region.includes(`'${label}'`), `the progress strip must include ${label}`);
    }
    assert.ok(/not run/.test(region), 'a stage that did not run must say so rather than showing a tick');
  });

  test('the index page has a workflow area and still no publish button', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
    assert.ok(html.includes('id="opportunityWorkflowArea"'));
    assert.ok(!/id="publish[A-Za-z]*"/i.test(html), 'no publish control may exist in the page');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
