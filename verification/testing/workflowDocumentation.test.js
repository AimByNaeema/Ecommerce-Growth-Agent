'use strict';

// The customer-facing workflow view and its downloadable PDF.
//
// WHAT THESE TESTS DEFEND: that the picture a customer is shown is the truth. A node reads
// "Completed" only because a real run said so; an unavailable figure stays unavailable; and
// a compliance PASS never sets the approval gate. Most of the file is about what must NOT
// appear, because a presentation layer is exactly where a comforting fiction would slip in.
//
// NO NETWORK. Run records are fixtures; the HTTP tests run against a locally started
// createApp() with a throwaway store, the same harness the other endpoint suites use.

const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.RUN_HISTORY_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-doc-test-'));
const TEST_API_KEY = 'test-agent-api-key-do-not-use-in-production';
process.env.AGENT_API_KEY = TEST_API_KEY;
process.env.RATE_LIMIT_MAX_REQUESTS = '10000';

const narrative = require('../../agent/core/workflowNarrative');
const projection = require('../../agent/core/workflowStateProjection');
const workflowDocument = require('../../documents/workflowDocument');
const { wrapText, measureText, sanitize } = require('../../documents/pdfWriter');
const { getSpecialistRegistry } = require('../../agent/core/specialistRegistry');
const { TASK_STATUSES } = require('../../agent/core/stateModel');
const runHistoryStore = require('../../agent/core/runHistoryStore');
const etsyReadClient = require('../../integrations/adapters/etsyReadClient');
const { createApp } = require('../../server');

// GET /overview performs a local credential check; pinned so this suite behaves the same on
// a machine with Etsy configured.
etsyReadClient.canRead = () => false;

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

// One saved record shaped exactly like a real orchestrate run.
function runRecord(steps, overrides = {}) {
  return Object.assign(
    {
      run_id: 'orch-workflow-test',
      kind: 'orchestrate',
      objective: 'Grow the store.',
      status: 'complete',
      created_at: '2026-09-10T00:00:00.000Z',
      result: { routing: { plan: steps } },
    },
    overrides
  );
}

function step(specialistId, completionState, extra = {}) {
  return Object.assign(
    {
      selected_specialist: { type: 'specialist', id: specialistId, title: specialistId },
      completion_state: completionState,
      current_task: `Work for ${specialistId}`,
      outputs: null,
      errors: [],
      approvals: [],
    },
    extra
  );
}

function authed(port, reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: reqPath, method: 'GET', headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks) }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function withServer(fn) {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await fn(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function clearStore() {
  for (const file of fs.readdirSync(process.env.RUN_HISTORY_STORE_DIR)) {
    fs.unlinkSync(path.join(process.env.RUN_HISTORY_STORE_DIR, file));
  }
}

(async () => {
  // -------------------------------------------------------------------------------------
  // 1-8. Every state, and the honesty of each one.
  // -------------------------------------------------------------------------------------

  test('1. with no run at all, every stage is Not run', () => {
    const state = projection.deriveWorkflowState({});
    assert.strictEqual(state.has_run, false);
    const labels = Object.values(state.stages).map((s) => s.state_label);
    assert.deepStrictEqual([...new Set(labels)], ['Not run'], `expected every stage Not run, got ${[...new Set(labels)].join(', ')}`);
    assert.strictEqual(state.run_id, null);
    assert.strictEqual(state.objective, null);
  });

  test('2. the map reflects the actual run, agent by agent', () => {
    const state = projection.deriveWorkflowState({
      record: runRecord([step('research', 'complete'), step('product', 'in_progress')]),
    });
    assert.strictEqual(state.has_run, true);
    assert.strictEqual(state.stages.research.state, 'completed');
    assert.strictEqual(state.stages.product.state, 'running');
    // An agent with no step did not run - and must not borrow another agent's status.
    assert.strictEqual(state.stages.seo.state, 'not_run');
    assert.strictEqual(state.stages.marketing.state, 'not_run');
  });

  test('3. Completed appears ONLY when the run actually completed that step', () => {
    for (const status of TASK_STATUSES) {
      const state = projection.deriveWorkflowState({ record: runRecord([step('seo', status)]) });
      const isCompleted = state.stages.seo.state === 'completed';
      assert.strictEqual(isCompleted, status === 'complete', `execution status '${status}' must not read as Completed`);
    }
    // And a step that exists but reports nothing never becomes Completed.
    const unknown = projection.deriveWorkflowState({ record: runRecord([step('seo', undefined)]) });
    assert.strictEqual(unknown.stages.seo.state, 'not_run');
  });

  test('4. Running state', () => {
    const state = projection.deriveWorkflowState({ record: runRecord([step('listing', 'in_progress')]) });
    assert.strictEqual(state.stages.listing.state_label, 'Running');
  });

  test('5. Waiting state comes from a pending human approval', () => {
    const session = { session_id: 's', opportunity_workflows: [{ ref: 1, approval_status: 'pending', compliance_status: 'PASS' }] };
    const state = projection.deriveWorkflowState({ record: runRecord([]), session });
    assert.strictEqual(state.stages.approval.state_label, 'Waiting');
    assert.strictEqual(state.stages.approval.verdict, 'pending');
    assert.ok(/nothing has been sent anywhere/i.test(state.stages.approval.detail));
  });

  test('6. Needs information state', () => {
    const state = projection.deriveWorkflowState({
      record: runRecord([step('product', 'complete', { outputs: { result: { status: 'needs_information' } } })]),
    });
    assert.strictEqual(state.stages.product.state_label, 'Needs information');
  });

  test('7. Blocked state, including a failed step', () => {
    assert.strictEqual(projection.deriveWorkflowState({ record: runRecord([step('seo', 'blocked')]) }).stages.seo.state_label, 'Blocked');
    const failedState = projection.deriveWorkflowState({ record: runRecord([step('seo', 'failed', { errors: ['The provider refused.'] })]) });
    assert.strictEqual(failedState.stages.seo.state_label, 'Blocked');
    // The real reason must survive the shared label.
    assert.ok(/provider refused/i.test(failedState.stages.seo.detail));
  });

  test('8. Not run is the default and says so plainly', () => {
    const state = projection.deriveWorkflowState({ record: runRecord([step('research', 'complete')]) });
    assert.strictEqual(state.stages.social_advertising.state_label, 'Not run');
    assert.ok(/did not run/i.test(state.stages.social_advertising.detail));
  });

  test('8b. when one agent ran twice, the worst outcome wins', () => {
    const state = projection.deriveWorkflowState({ record: runRecord([step('research', 'complete'), step('research', 'blocked')]) });
    assert.strictEqual(state.stages.research.state, 'blocked', 'a customer must not see Completed because one of two steps finished');
    assert.strictEqual(projection.worstState(['completed', 'running']), 'running');
  });

  // -------------------------------------------------------------------------------------
  // 9-11. Agent detail, the evidence chain, and missing evidence.
  // -------------------------------------------------------------------------------------

  test('9. every stage carries the detail the drawer needs', () => {
    for (const stage of narrative.STAGE_DEFINITIONS) {
      assert.ok(stage.purpose && stage.purpose.length > 10, `${stage.key} needs a purpose`);
      assert.ok(stage.does && stage.does.length > 20, `${stage.key} needs a description`);
      assert.ok(Array.isArray(stage.inputs) && stage.inputs.length > 0, `${stage.key} needs inputs`);
      assert.ok(Array.isArray(stage.outputs) && stage.outputs.length > 0, `${stage.key} needs outputs`);
      // A next step may legitimately be a single agent name ("SEO"), so this only requires
      // that one is stated at all.
      assert.ok(typeof stage.nextStep === 'string' && stage.nextStep.trim() !== '', `${stage.key} needs a next step`);
    }
    // The seven agents are the registry's, not a retyped list.
    const registryIds = getSpecialistRegistry().map((s) => s.id).sort();
    const agentIds = narrative.getAgentStages().map((s) => s.specialistId).sort();
    assert.deepStrictEqual(agentIds, registryIds, 'the documented agents must be exactly the registered specialists');
  });

  test('10. the evidence chain is relayed from the persisted opportunity', () => {
    const chain = projection.buildEvidenceChain({
      rank: 1,
      product: 'Sticker Bundle',
      market: 'stickers',
      customer_fit_reason: 'Overlaps what you already sell.',
      demand: { assessment: 'Widely sold.', value: null, grade: 'inferred', source: ['https://real.test/a'] },
      competition: { assessment: 'Crowded.', value: 4300, unit: 'listings', grade: 'measured', source: ['https://real.test/a'] },
      trend: { classification: 'seasonal', assessment: 'Peaks in December.', grade: 'inferred' },
      commercial: { assessment: 'Low price point.', grade: 'inferred' },
      scores: { customer_fit: 100, evidence_coverage: 75, rank_basis: 'Equal-weight mean.' },
      compliance: { status: 'PASS', review_reasons: [] },
      evidence: [{ source_url: 'https://real.test/a' }, { source_url: 'https://real.test/a' }],
    });
    assert.deepStrictEqual(chain.research_evidence.sources, ['https://real.test/a'], 'sources are de-duplicated');
    assert.strictEqual(chain.customer_fit.reason, 'Overlaps what you already sell.');
    assert.strictEqual(chain.opportunity_evaluation.competition.value, 4300, 'a real measured figure is relayed exactly');
    assert.strictEqual(chain.opportunity_evaluation.competition.unit, 'listings');
    assert.strictEqual(chain.opportunity_evaluation.evidence_coverage, 75);
    assert.strictEqual(chain.compliance.status, 'PASS');
    // The five links the customer is promised.
    assert.deepStrictEqual(narrative.EVIDENCE_CHAIN.map((l) => l.key), ['research_evidence', 'customer_fit', 'opportunity_evaluation', 'compliance', 'preparation']);
  });

  test('11. an unestablished figure stays unavailable and never becomes 0', () => {
    const chain = projection.buildEvidenceChain({
      rank: 2,
      product: 'Plain Planner',
      demand: { assessment: 'Not available from current research sources.', value: null, grade: 'unknown', source: [] },
      competition: { value: null, grade: 'unknown' },
      trend: { classification: 'unknown' },
      scores: {},
      evidence: [],
    });
    assert.strictEqual(chain.opportunity_evaluation.demand.value, null, 'null must stay null');
    assert.notStrictEqual(chain.opportunity_evaluation.demand.value, 0, 'unavailable must never render as zero');
    assert.strictEqual(chain.opportunity_evaluation.demand.available, false);
    assert.strictEqual(chain.opportunity_evaluation.competition.value, null);
    assert.strictEqual(chain.opportunity_evaluation.evidence_coverage, null);
    assert.strictEqual(chain.research_evidence.count, 0);
    assert.strictEqual(chain.customer_fit.reason, null);
    assert.ok(/^Not available from the connected research sources\.$/.test(narrative.UNAVAILABLE_TEXT));
  });

  // -------------------------------------------------------------------------------------
  // 12-15. The two gates, and the line between them.
  // -------------------------------------------------------------------------------------

  test('12. compliance PASS', () => {
    const session = { opportunity_workflows: [{ ref: 1, compliance_status: 'PASS' }] };
    const state = projection.deriveWorkflowState({ record: runRecord([]), session });
    assert.strictEqual(state.stages.compliance.verdict, 'PASS');
    assert.strictEqual(state.stages.compliance.state, 'completed');
  });

  test('13. compliance REVIEW is never presented as cleared', () => {
    const session = { opportunity_workflows: [{ ref: 1, compliance_status: 'REVIEW' }] };
    const state = projection.deriveWorkflowState({ record: runRecord([]), session });
    assert.strictEqual(state.stages.compliance.verdict, 'REVIEW');
    assert.notStrictEqual(state.stages.compliance.state, 'completed', 'REVIEW must not read as a clean pass');
  });

  test('14. compliance BLOCK, and BLOCK dominates a mixed set', () => {
    const session = { opportunity_workflows: [{ ref: 1, compliance_status: 'PASS' }, { ref: 2, compliance_status: 'BLOCK' }] };
    const state = projection.deriveWorkflowState({ record: runRecord([]), session });
    assert.strictEqual(state.stages.compliance.verdict, 'BLOCK', 'the safest reading must win, never the most flattering');
    assert.strictEqual(state.stages.compliance.state, 'blocked');
  });

  test('15. a compliance PASS never approves anything', () => {
    const session = { opportunity_workflows: [{ ref: 1, compliance_status: 'PASS' }] };
    const state = projection.deriveWorkflowState({ record: runRecord([]), session });
    assert.strictEqual(state.stages.compliance.verdict, 'PASS');
    assert.strictEqual(state.stages.approval.state, 'not_run', 'approval must be untouched by a compliance verdict');
    assert.strictEqual(state.stages.approval.verdict, null);

    // Nor does an auto-approved analysis step count as a human decision.
    const auto = projection.deriveWorkflowState({
      record: runRecord([step('research', 'complete', { approvals: [{ classification: 'analysis_only', status: 'auto_approved' }] })]),
    });
    assert.strictEqual(auto.stages.approval.state, 'not_run', 'an auto-approved tool call is not a human approval');

    // The two vocabularies are disjoint, and the copy says so.
    const complianceStage = narrative.getStage('compliance');
    const approvalStage = narrative.getStage('approval');
    assert.ok(/separate/i.test(complianceStage.nextStep) || /separate/i.test(approvalStage.does));
    assert.ok(/not authorise|not permission/i.test(complianceStage.verdicts.find((v) => v.id === 'PASS').meaning));
  });

  // -------------------------------------------------------------------------------------
  // 16-17. No fabrication, and the growth loop.
  // -------------------------------------------------------------------------------------

  test('16. the platform boundary never claims an action, and no publishing is described', () => {
    const state = projection.deriveWorkflowState({ record: runRecord([step('research', 'complete')]) });
    assert.strictEqual(state.stages.platform_action.state, 'not_run');
    assert.ok(/reading only/i.test(state.stages.platform_action.detail));
    const boundary = narrative.getStage('platform_action');
    assert.ok(/no ability to publish|holds no ability|reading only/i.test(boundary.does));
  });

  test('17. Marketing -> Social -> Analytics, and the loop back', () => {
    assert.deepStrictEqual(narrative.GROWTH_LOOP, ['marketing', 'social_advertising', 'analytics_optimization']);
    assert.strictEqual(narrative.getStage('marketing').nextStep, 'Social & Advertising');
    assert.ok(/Analytics/.test(narrative.getStage('social_advertising').nextStep));
    assert.strictEqual(narrative.getStage('analytics_optimization').feedsBackTo, 'marketing');
    assert.ok(/Marketing/.test(narrative.getStage('analytics_optimization').nextStep));
  });

  test('17b. the flow is described as conditional, not as always-every-agent', () => {
    assert.ok(/only the specialists your goal actually needs/i.test(narrative.CONDITIONAL_NOTE));
    assert.ok(narrative.assertTaskStatusCoverage(), 'every execution status must map to a customer-facing state');
  });

  // -------------------------------------------------------------------------------------
  // 18-20. The PDF.
  // -------------------------------------------------------------------------------------

  test('18. the PDF generates as a structurally valid document', () => {
    const pdf = workflowDocument.buildWorkflowDocument();
    assert.ok(Buffer.isBuffer(pdf));
    assert.ok(pdf.length > 20000, `expected a substantial document, got ${pdf.length} bytes`);
    const text = pdf.toString('latin1');
    assert.ok(text.startsWith('%PDF-'), 'must carry a PDF header');
    assert.ok(text.trimEnd().endsWith('%%EOF'), 'must be terminated properly');
    // The cross-reference table must point at real objects, or no reader will open it.
    const startxref = Number(text.slice(text.lastIndexOf('startxref') + 9).trim().split(/\s/)[0]);
    assert.strictEqual(text.slice(startxref, startxref + 4), 'xref');
    const rows = text.slice(startxref).split('\n').slice(2).filter((l) => /^\d{10} \d{5} n/.test(l));
    rows.forEach((row, index) => {
      const offset = Number(row.slice(0, 10));
      assert.strictEqual(text.slice(offset, offset + `${index + 1} 0 obj`.length), `${index + 1} 0 obj`, `xref entry ${index + 1} must resolve`);
    });
    assert.ok((text.match(/\/Type \/Page[^s]/g) || []).length >= 15, 'the document should span many pages');
  });

  test('19. the PDF contains every required section', () => {
    const text = workflowDocument.buildWorkflowDocument().toString('latin1');
    const missing = workflowDocument.REQUIRED_SECTIONS.filter((section) => !text.includes(sanitize(section)));
    assert.deepStrictEqual(missing, [], `missing sections: ${missing.join(' | ')}`);
    // The seven agents, the two gates and the boundary each get their own treatment.
    for (const agent of narrative.getAgentStages()) {
      assert.ok(text.includes(sanitize(agent.title)), `${agent.title} must appear`);
    }
    for (const marker of ['Claude', 'Gemini', 'Tavily', 'PASS', 'REVIEW', 'BLOCK']) {
      assert.ok(text.includes(marker), `${marker} must be documented`);
    }
    assert.ok(text.includes(sanitize(narrative.UNAVAILABLE_TEXT)), 'the unavailable promise must be stated verbatim');
  });

  test('20. the PDF contains no credential, path or internal detail', () => {
    const text = workflowDocument.buildWorkflowDocument().toString('latin1');
    const forbidden = [
      [/sk-ant-/, 'anthropic key'], [/shpat_|shpss_/, 'shopify token'], [/AIza[0-9A-Za-z_-]{10}/, 'google key'],
      [/tvly-/, 'tavily key'], [/Bearer /, 'authorization header'], [/api[_-]?key/i, 'api key'],
      [/access_token|refresh_token|client_secret|keystring/i, 'oauth material'],
      [/C:\\\\|\/Users\/|node_modules|memory\/state/i, 'file path'],
      [/\.js\b/, 'internal module name'], [/localhost|127\.0\.0\.1/, 'internal host'],
      [/myshopify\.com/, 'store domain'], [/Error:|stack trace|at Object\./, 'error trace'],
    ];
    for (const [pattern, label] of forbidden) {
      assert.ok(!pattern.test(text), `the customer PDF must not contain a ${label}`);
    }
    // It documents capability, so it must not carry run data either.
    assert.ok(!/run_id|cc-run-|orch-/.test(text), 'the document must carry no run identifiers');
  });

  test('20b. PDF text handling is safe', () => {
    assert.strictEqual(sanitize('a\u2019b \u2014 c\u201Dd'), "a'b - c\"d", 'typographic characters map to ASCII');
    assert.ok(!/[^\x20-\x7E]/.test(sanitize('emoji \u{1F600} and \u00e9')), 'anything unencodable is dropped');
    const lines = wrapText('word '.repeat(60), 10, 'regular', 200);
    assert.ok(lines.length > 1, 'long text wraps');
    lines.forEach((line) => assert.ok(measureText(line, 10, 'regular') <= 200, 'no wrapped line may exceed the column'));
    assert.ok(wrapText('Supercalifragilisticexpialidocious'.repeat(4), 10, 'regular', 60).length > 1, 'an over-long word is split, never allowed to run off the page');
  });

  // -------------------------------------------------------------------------------------
  // 21, 23, 24. The endpoints, and everything that was already there.
  // -------------------------------------------------------------------------------------

  await testAsync('21. the download endpoint serves the PDF as an attachment', async () => {
    await withServer(async (port) => {
      const res = await authed(port, '/workflow/document.pdf');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers['content-type'], 'application/pdf');
      assert.ok(/attachment; filename=/.test(res.headers['content-disposition']));
      assert.ok(/AVENLY-AI/.test(res.headers['content-disposition']));
      assert.strictEqual(res.buffer.toString('latin1', 0, 5), '%PDF-');
      assert.strictEqual(Number(res.headers['content-length']), res.buffer.length);
    });
  });

  await testAsync('21b. the endpoints require the API key', async () => {
    await withServer(async (port) => {
      const unauthorized = await new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, path: '/workflow/document.pdf', method: 'GET' }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.end();
      });
      assert.strictEqual(unauthorized, 401, 'the document must not be readable without the key');
    });
  });

  await testAsync('21c. GET /workflow/state reports Not run with an empty store, and reflects a saved run', async () => {
    clearStore();
    await withServer(async (port) => {
      const empty = JSON.parse((await authed(port, '/workflow/state')).buffer.toString());
      assert.strictEqual(empty.has_run, false);
      assert.deepStrictEqual([...new Set(Object.values(empty.stages).map((s) => s.state_label))], ['Not run']);
      assert.ok(Array.isArray(empty.stage_definitions) && empty.stage_definitions.length === narrative.STAGE_DEFINITIONS.length);
      assert.ok(empty.conditional_note && empty.unavailable_text);
    });

    runHistoryStore.saveRunRecord(runRecord([step('research', 'complete'), step('product', 'blocked')], { run_id: 'orch-workflow-live' }));
    await withServer(async (port) => {
      const live = JSON.parse((await authed(port, '/workflow/state')).buffer.toString());
      assert.strictEqual(live.has_run, true);
      assert.strictEqual(live.stages.research.state_label, 'Completed');
      assert.strictEqual(live.stages.product.state_label, 'Blocked');
      assert.strictEqual(live.stages.listing.state_label, 'Not run');
      assert.strictEqual(live.stages.approval.state_label, 'Not run');
    });
    clearStore();
  });

  await testAsync('21d. an unknown opportunity rank is an honest 404, never an invented chain', async () => {
    clearStore();
    await withServer(async (port) => {
      const res = await authed(port, '/workflow/evidence/9');
      assert.strictEqual(res.status, 404);
      const body = JSON.parse(res.buffer.toString());
      assert.strictEqual(body.available, false);
    });
  });

  await testAsync('23 & 24. the existing Command Center, overview and history surfaces still work', async () => {
    clearStore();
    await withServer(async (port) => {
      const overview = await authed(port, '/overview');
      assert.strictEqual(overview.status, 200, 'GET /overview must still respond');
      const payload = JSON.parse(overview.buffer.toString());
      for (const key of ['business', 'channels', 'specialists', 'activity', 'opportunities', 'market_research', 'health']) {
        assert.ok(key in payload, `/overview must still carry ${key}`);
      }
      const history = await authed(port, '/history');
      assert.strictEqual(history.status, 200, 'GET /history must still respond');
      const sessions = await authed(port, '/sessions');
      assert.strictEqual(sessions.status, 200, 'GET /sessions must still respond');
      assert.ok(Array.isArray(JSON.parse(sessions.buffer.toString()).sessions));
    });
  });

  // -------------------------------------------------------------------------------------
  // 22. Mobile-safe representation, and no second architecture.
  // -------------------------------------------------------------------------------------

  test('22. the workflow is vertical by default and only spreads sideways with room', () => {
    const css = fs.readFileSync(path.join(__dirname, '../../public/dashboard.css'), 'utf8');
    const base = css.slice(css.indexOf('.workflow-graph {'), css.indexOf('.workflow-node {'));
    assert.ok(/flex-direction:\s*column/.test(base), 'the default must be a readable vertical stack');
    assert.ok(/\.flow-group-row \{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/.test(css), 'the specialist stage must stack in one column by default');
    assert.ok(/@container workflow \(min-width: \d+px\)[\s\S]*?\.flow-group-row \{[^}]*grid-template-columns:\s*repeat/.test(css), 'the specialist stage spreads sideways only when the map itself has room');
    assert.ok(/@media \(max-width: 420px\)[\s\S]*?\.workflow-drawer-panel \{[^}]*width:\s*100%/.test(css), 'the drawer must use the full width on a phone');
    assert.ok(/overflow-wrap:\s*anywhere/.test(css), 'long labels must wrap rather than overflow');
  });

  test('22b. no second engine, registry or state system was introduced', () => {
    const projectionSource = fs.readFileSync(path.join(__dirname, '../../agent/core/workflowStateProjection.js'), 'utf8');
    const code = projectionSource.split('\n').map((l) => l.replace(/\r$/, '').replace(/^\s*\/\/.*$/, '')).join('\n');
    for (const forbidden of ['buildPlanStep', 'runOrchestratorContract', 'saveRunRecord', 'createApprovalRequest', 'evaluateCompliance', 'fetch(']) {
      assert.ok(!code.includes(forbidden), `the projection must not call ${forbidden} - it only reads records`);
    }
    const narrativeSource = fs.readFileSync(path.join(__dirname, '../../agent/core/workflowNarrative.js'), 'utf8');
    assert.ok(narrativeSource.includes("require('./specialistRegistry')"), 'the agent list must come from the existing registry');
    // The document is built from the narrative, so page and PDF cannot drift.
    const documentSource = fs.readFileSync(path.join(__dirname, '../../documents/workflowDocument.js'), 'utf8');
    assert.ok(documentSource.includes("require('../agent/core/workflowNarrative')"), 'the PDF must be composed from the shared definitions');
  });

  test('22c. this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('workflowDocumentation.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
