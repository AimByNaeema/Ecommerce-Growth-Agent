'use strict';

// Tests for the research_analysis tool - the wiring that makes the three already-built
// but unreachable agent/core/researchAgent.js capabilities routable:
// global_market_research, trend_research, and opportunity_discovery (the "HONEST tool_ids
// GAPS" agent/core/specialistCapabilityRegistry.js's own header declared).
//
// These cover only the connecting wiring - the tool, its registry/permission/usage-limit
// entries, and real reachability through the normal Chief routing path. The research
// logic itself is not re-tested here: researchAgent.test.js still owns every composition
// assertion, and none of it was rewritten.
//
// Every value below is an invented placeholder. No network call is made anywhere - all
// three capabilities compose records from caller-supplied evidence only.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  SUPPORTED_RESEARCH_TYPES,
  RESEARCH_TYPES_OWNED_BY_OTHER_TOOLS,
  runResearchAnalysisTool,
} = require('../../tools/researchAnalysisTool');
const { getToolById } = require('../../tools/toolRegistry');
const { checkToolAccess, TOOL_CLASSIFICATIONS } = require('../../agent/core/toolPermissions');
const { RESEARCH_TOOL_IDS, EXTERNAL_API_TOOL_IDS } = require('../../agent/core/usageLimits');
const { getCapabilityTask, getSpecialistCapabilityById } = require('../../agent/core/specialistCapabilityRegistry');
const { runOrchestratorContract } = require('../../agent/core/orchestratorExecutionContract');

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

const EVIDENCE = [{ topic: '(placeholder) topic', finding: '(placeholder) finding', source: ['(placeholder source)'] }];

// Real, minimal params per capability - the exact shapes each handler requires.
const PARAMS = {
  global_market_research: { markets: [{ market: '(placeholder) United States', evidence: EVIDENCE }] },
  trend_research: { trends: [{ topic: '(placeholder) sustainable materials', finding: '(placeholder) observation', source: ['(placeholder source)'] }] },
  opportunity_discovery: { signals: [{ topic: '(placeholder) bundle demand', finding: '(placeholder) observation', source: ['(placeholder source)'] }] },
};

(async () => {
  // --- The three capabilities the tool owns ----------------------------------------

  test('the tool covers exactly the three previously-unwired capabilities', () => {
    assert.deepStrictEqual(SUPPORTED_RESEARCH_TYPES, ['global_market_research', 'trend_research', 'opportunity_discovery']);
  });

  test('NO NEW ENGINE AND NO SECOND DISPATCHER - it goes through researchAgent runResearch', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'researchAnalysisTool.js'), 'utf8');
    const code = source.replace(/^\s*\/\/.*$/gm, '');
    assert.ok(code.includes("require('../agent/core/researchAgent')"), 'it must use the existing research agent');
    assert.ok(code.includes('runResearch({ researchType'), 'it must use the agent\'s own dispatcher');
    // It must not call the three handlers directly - that would be a second capability table.
    for (const handler of ['runGlobalMarketResearch', 'runTrendResearch', 'runOpportunityDiscovery']) {
      assert.ok(!code.includes(`${handler}(`), `${handler} must be reached through runResearch, not called directly`);
    }
  });

  test('NO DUPLICATE ROUTE: an already-wired researchType is refused, naming the owning tool', () => {
    for (const [researchType, owningTool] of Object.entries(RESEARCH_TYPES_OWNED_BY_OTHER_TOOLS)) {
      const outcome = runResearchAnalysisTool({ researchType });
      assert.strictEqual(outcome.status, 'failed', researchType);
      assert.strictEqual(outcome.result, null);
      assert.ok(outcome.error.includes(owningTool.split(' ')[0]), `${researchType} must name ${owningTool}`);
    }
    // And those capabilities still point at their own tools, untouched.
    assert.deepStrictEqual(getCapabilityTask('research', 'market_research').tool_ids, ['market_research']);
    assert.deepStrictEqual(getCapabilityTask('research', 'customer_segmentation').tool_ids, ['customer_research']);
  });

  test('the tool reports honestly instead of guessing', () => {
    assert.strictEqual(runResearchAnalysisTool(undefined).status, 'failed');
    assert.strictEqual(runResearchAnalysisTool({ researchType: 'not_a_real_type' }).status, 'failed');
    // A required field that is genuinely missing fails - it is never invented.
    const missing = runResearchAnalysisTool({ researchType: 'trend_research' });
    assert.strictEqual(missing.status, 'failed');
    assert.ok(missing.error.includes('trends'));
  });

  test('each capability composes real records from caller-supplied evidence', () => {
    for (const researchType of SUPPORTED_RESEARCH_TYPES) {
      const outcome = runResearchAnalysisTool({ researchType, ...PARAMS[researchType] });
      assert.strictEqual(outcome.status, 'success', `${researchType}: ${outcome.error || ''}`);
      assert.strictEqual(outcome.result.research_type, researchType);
      assert.ok(outcome.result.specialized_records.length > 0, researchType);
    }
  });

  test('no evidence supplied is reported as empty, never as a confident result', () => {
    const outcome = runResearchAnalysisTool({ researchType: 'trend_research', trends: [{ topic: '(placeholder) bare topic' }] });
    assert.strictEqual(outcome.status, 'empty');
    assert.ok(outcome.result.limitations.some((l) => l.startsWith('No evidence was supplied for')));
  });

  // --- Registry / permissions / usage limits ---------------------------------------

  test('the tool is registered in the shared tool registry', () => {
    const tool = getToolById('research_analysis');
    assert.ok(tool, 'research_analysis must be a real tool');
    assert.strictEqual(tool.category, 'research');
    assert.strictEqual(tool.operation, 'read');
    assert.strictEqual(tool.status, 'implemented');
  });

  test('permissions: Research owns it, and it is analysis_only', () => {
    assert.strictEqual(TOOL_CLASSIFICATIONS.research_analysis, 'analysis_only');
    assert.strictEqual(checkToolAccess({ specialistId: 'research', toolId: 'research_analysis' }).decision, 'allowed');
    // A specialist that does not own the research category still cannot reach it.
    assert.notStrictEqual(checkToolAccess({ specialistId: 'listing', toolId: 'research_analysis' }).decision, 'allowed');
    assert.ok(getSpecialistCapabilityById('research').required_tools.includes('research_analysis'));
  });

  test('usage limits: it counts as a research call, and is NOT an external API call', () => {
    assert.ok(RESEARCH_TOOL_IDS.has('research_analysis'), 'it backs research tasks, so it counts toward the research budget');
    assert.ok(!EXTERNAL_API_TOOL_IDS.has('research_analysis'), 'it is deterministic and makes no external call');
  });

  test('all three capabilities now declare the tool, and no Research capability is unwired', () => {
    for (const capabilityId of SUPPORTED_RESEARCH_TYPES) {
      assert.deepStrictEqual(getCapabilityTask('research', capabilityId).tool_ids, ['research_analysis'], capabilityId);
    }
    for (const task of getSpecialistCapabilityById('research').supported_tasks) {
      assert.ok(task.tool_ids.length > 0, `${task.id} still has no tool wired`);
    }
  });

  // --- Real reachability through the Chief routing path -----------------------------

  await testAsync('REACHABLE THROUGH CHIEF: each capability routes and executes for real', async () => {
    // Objectives phrased in each capability's OWN distinguishing vocabulary. Routing is
    // word-overlap based, so an objective that equally describes a neighbouring
    // capability legitimately routes there instead - see this file's closing note.
    const objectives = {
      global_market_research: 'Run a multi-market study of the markets we sell in',
      trend_research: 'Run trend research on trending topics we have observed',
      // "opportunity" alone pulls the specialist toward Product, so this names Research's
      // own capability explicitly - see the closing note on routing ambiguity.
      opportunity_discovery: 'Run opportunity discovery research on our observed signals',
    };
    for (const [capabilityId, objective] of Object.entries(objectives)) {
      const response = await runOrchestratorContract(objective, { researchParams: PARAMS[capabilityId] });
      assert.strictEqual(response.routing.status, 'planned', `${capabilityId}: ${response.routing.reason || ''}`);
      const step = (response.routing.plan || [])[0];
      assert.ok(step, `${capabilityId}: a plan step must exist`);
      assert.strictEqual(step.selected_specialist.id, 'research', capabilityId);
      assert.strictEqual(step.inputs.capability_id, capabilityId);
      assert.strictEqual(step.inputs.tool_id, 'research_analysis', capabilityId);
      assert.strictEqual(step.outputs.status, 'success', capabilityId);
      assert.strictEqual(step.outputs.result.research_type, capabilityId);
    }
  });

  await testAsync('the orchestrator supplies researchType itself from the routed capability', async () => {
    // The caller passes no researchType - TOOL_CAPABILITY_SELECTORS derives it from the
    // routed capability id (valueMap null), so a normal Chief route never sets it by hand.
    assert.ok(!('researchType' in PARAMS.trend_research));
    const response = await runOrchestratorContract('Run trend research on trending topics we have observed', {
      researchParams: PARAMS.trend_research,
    });
    assert.strictEqual(response.routing.plan[0].outputs.result.research_type, 'trend_research');
  });

  await testAsync('execution is deterministic and audited - no tokens, no model call', async () => {
    const response = await runOrchestratorContract('Run trend research on trending topics we have observed', {
      researchParams: PARAMS.trend_research,
    });
    assert.strictEqual(response.usage_summary.by_category.model_call.count, 0);
    assert.ok(response.audit_trail.length > 0, 'the run must be audited');
    assert.ok(response.usage_ledger.length > 0, 'the tool call must be recorded in the usage ledger');
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('researchAnalysisTool.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
