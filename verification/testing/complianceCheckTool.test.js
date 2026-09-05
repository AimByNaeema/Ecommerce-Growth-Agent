'use strict';

// Tests for the compliance_check tool (tools/complianceCheckTool.js) - the shared-core
// Compliance stage - and its wiring into the shared execution stack (registry,
// permissions, classification, usage limits, token controls, audit, provider selection).
//
// NO REAL MODEL CALL IS EVER MADE. The deterministic path makes none at all, which is
// asserted rather than assumed. For the optional AI-assisted pass, BOTH provider clients
// are replaced on their shared, cached module objects for every test, so neither
// AI_PROVIDER value can reach a real API even if the local .env carries a live key.
// AI_PROVIDER is pinned explicitly per test rather than inherited from the developer's
// environment.
//
// NO SHOPIFY, MARKETPLACE, SOCIAL, ADVERTISING OR PUBLISHING CALL IS MADE ANYWHERE.
//
// Every question, brand, phrase and draft below is an invented placeholder.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const claudeClient = require('../../agent/core/claudeClient');
const geminiClient = require('../../agent/core/geminiClient');
const { runComplianceCheckTool } = require('../../tools/complianceCheckTool');
const { getToolById, TOOL_CATEGORIES } = require('../../tools/toolRegistry');
const {
  checkToolAccess,
  TOOL_CLASSIFICATIONS,
  SHARED_INFRASTRUCTURE_CATEGORIES,
  SPECIALIST_ROLE_PERMISSIONS,
  CATEGORY_TO_SPECIALIST,
} = require('../../agent/core/toolPermissions');
const { SPECIALIST_REGISTRY } = require('../../agent/core/specialistRegistry');
const { createUsageTracker, checkUsageLimits, MODEL_CALL_TOOL_IDS } = require('../../agent/core/usageLimits');
const { getMaxTokensPerRun } = require('../../agent/core/tokenControls');
const { createAuditTracker, appendAuditEvent, getEventsByType } = require('../../audit/auditTrail');
const { validateComplianceResultShape, createGovernanceRecord } = require('../../compliance/complianceModel');

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

const CLEAN_CONTENT =
  'How long an insulated jacket lasts depends on how often you wear it, how you store it, and how you wash it. With careful storage and gentle washing, a well-made insulated jacket stays warm and usable for a long time.';

const GOOD_PROVENANCE = {
  source: 'seo_content_generation',
  generator: 'tools/seoContentGenerationTool.js',
  evidence: [{ signal_kind: 'competitor_faq', reference: '(placeholder FAQ reference)' }],
};

const EMPTY_FINDINGS_REPLY = '{"findings":[]}';

// Replaces BOTH clients so no configuration can produce a real call, and records which
// one the provider selector actually reached.
async function withMockedProviders({ provider = 'claude', text = EMPTY_FINDINGS_REPLY, throws = null }, fn) {
  const savedProvider = process.env.AI_PROVIDER;
  const savedClaude = claudeClient.sendMessage;
  const savedGemini = geminiClient.sendMessage;
  const savedClaudeKey = process.env.ANTHROPIC_API_KEY;
  const savedGeminiKey = process.env.GEMINI_API_KEY;

  process.env.AI_PROVIDER = provider;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-not-real';
  process.env.GEMINI_API_KEY = 'gemini-test-key-not-real';

  const hits = { claude: 0, gemini: 0, sent: [] };
  claudeClient.sendMessage = async (request) => {
    hits.claude += 1;
    hits.sent.push(request.messages[0].content);
    if (throws) throw new Error(throws);
    return { text, model: 'claude-sonnet-5', stopReason: 'end_turn', usage: { input_tokens: 120, output_tokens: 40 } };
  };
  geminiClient.sendMessage = async (request) => {
    hits.gemini += 1;
    hits.sent.push(request.messages[0].content);
    if (throws) throw new Error(throws);
    return {
      text,
      model: 'gemini-2.5-flash',
      stopReason: 'STOP',
      usage: { promptTokenCount: 120, candidatesTokenCount: 40 },
    };
  };

  try {
    return await fn(hits);
  } finally {
    claudeClient.sendMessage = savedClaude;
    geminiClient.sendMessage = savedGemini;
    if (savedProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = savedProvider;
    if (savedClaudeKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedClaudeKey;
    if (savedGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedGeminiKey;
  }
}

(async () => {
  // --- Registration and permissions ----------------------------------------------

  test('the tool is registered under the existing conventions, as a read operation', () => {
    const tool = getToolById('compliance_check');
    assert.ok(tool, 'compliance_check is not in the tool registry');
    assert.strictEqual(tool.status, 'implemented');
    assert.strictEqual(tool.category, 'compliance');
    // It validates; it authors nothing. 'read' is the honest operation type.
    assert.strictEqual(tool.operation, 'read');
    assert.ok(TOOL_CATEGORIES.includes('compliance'));
  });

  test('PERMISSIONS: compliance is shared infrastructure - NO specialist owns it', () => {
    // Derived, not hand-declared: absent from CATEGORY_TO_SPECIALIST means shared.
    assert.ok(!('compliance' in CATEGORY_TO_SPECIALIST));
    assert.ok(SHARED_INFRASTRUCTURE_CATEGORIES.includes('compliance'));

    // The orchestrator itself may call it...
    assert.strictEqual(checkToolAccess({ specialistId: null, toolId: 'compliance_check' }).decision, 'allowed');
    // ...and not one of the 7 specialists can, so there is no side channel around the
    // shared infrastructure (CLAUDE.md section 2).
    for (const specialist of SPECIALIST_REGISTRY) {
      assert.strictEqual(
        checkToolAccess({ specialistId: specialist.id, toolId: 'compliance_check' }).decision,
        'denied',
        `${specialist.id} must not be able to reach compliance_check directly`
      );
    }
  });

  test('PERMISSIONS ARE NOT WEAKENED: no role ceiling changed to accommodate this tool', () => {
    // The role table is the ceiling. Adding Compliance must not have widened any of it.
    assert.deepStrictEqual(SPECIALIST_ROLE_PERMISSIONS.research, ['read']);
    assert.deepStrictEqual(SPECIALIST_ROLE_PERMISSIONS.product, ['read']);
    assert.deepStrictEqual(SPECIALIST_ROLE_PERMISSIONS.seo, ['read', 'write']);
    assert.deepStrictEqual(SPECIALIST_ROLE_PERMISSIONS.listing, ['write']);
    assert.deepStrictEqual(SPECIALIST_ROLE_PERMISSIONS.marketing, ['write']);
    assert.deepStrictEqual(SPECIALIST_ROLE_PERMISSIONS.social_advertising, ['read', 'write']);
    assert.deepStrictEqual(SPECIALIST_ROLE_PERMISSIONS.analytics_optimization, ['read']);
  });

  test('the smallest honest classification: analysis_only, so it needs no approval to run', () => {
    assert.strictEqual(TOOL_CLASSIFICATIONS.compliance_check, 'analysis_only');
    assert.strictEqual(checkToolAccess({ specialistId: null, toolId: 'compliance_check' }).approval_required, false);
  });

  test('COST CONTROLS: it counts against the run model-call budget', () => {
    assert.ok(MODEL_CALL_TOOL_IDS.has('compliance_check'));
    const usageTracker = createUsageTracker();
    usageTracker.modelCalls = 999;
    const check = checkUsageLimits('compliance_check', usageTracker);
    assert.strictEqual(check.allowed, false);
    assert.strictEqual(check.limitType, 'model_calls');
  });

  test('COST CONTROLS: the generic per-run tool-call ceiling also applies', () => {
    const usageTracker = createUsageTracker();
    usageTracker.toolCalls = 9999;
    assert.strictEqual(checkUsageLimits('compliance_check', usageTracker).limitType, 'tool_calls');
  });

  test('AUDIT: a compliance step is recordable on the existing per-run trail', () => {
    const tracker = createAuditTracker('run-compliance-1');
    appendAuditEvent(tracker, {
      type: 'execution',
      toolId: 'compliance_check',
      classification: TOOL_CLASSIFICATIONS.compliance_check,
      summary: "Executing tool 'compliance_check'.",
      detail: { content_reference: '(placeholder)', apiKey: 'sk-ant-CANARY-must-not-appear' },
    });
    appendAuditEvent(tracker, {
      type: 'result',
      toolId: 'compliance_check',
      status: 'success',
      summary: 'Compliance verdict: PASS.',
    });
    assert.strictEqual(getEventsByType(tracker, 'execution').length, 1);
    assert.strictEqual(getEventsByType(tracker, 'result').length, 1);
    // The existing redaction applies unchanged - no new secret path was opened.
    assert.ok(!JSON.stringify(tracker).includes('sk-ant-CANARY-must-not-appear'));
  });

  test('the tool is reachable ONLY through the gated dispatch surface', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'agent', 'core', 'orchestratorExecutionContract.js'),
      'utf8'
    );
    assert.ok(source.includes("complianceCheckTool = require('../../tools/complianceCheckTool')"));
    assert.ok(/compliance_check:\s*\(executionRequest, runTokenTracker\)/.test(source));
  });

  // --- The deterministic path: free, and the only source of a BLOCK ---------------

  await testAsync('a PASS verdict maps to tool status success, and costs no tokens at all', async () => {
    await withMockedProviders({}, async (hits) => {
      const outcome = await runComplianceCheckTool({ content: CLEAN_CONTENT, provenance: GOOD_PROVENANCE });
      assert.strictEqual(outcome.status, 'success');
      assert.strictEqual(outcome.result.status, 'PASS');
      assert.strictEqual(outcome.error, null);
      assert.strictEqual(validateComplianceResultShape(outcome.result).valid, true);
      // The default path is deterministic: no model was reached and nothing was spent.
      assert.strictEqual(hits.claude + hits.gemini, 0);
      assert.strictEqual(outcome.tokensUsed, undefined);
    });
  });

  await testAsync('a REVIEW verdict maps to tool status partial and preserves its reasons', async () => {
    await withMockedProviders({}, async (hits) => {
      const outcome = await runComplianceCheckTool({
        content: 'An insulated jacket typically lasts [VERIFY: typical lifespan] with normal use.',
        provenance: GOOD_PROVENANCE,
      });
      assert.strictEqual(outcome.status, 'partial');
      assert.strictEqual(outcome.result.status, 'REVIEW');
      assert.ok(outcome.result.review_reasons.length > 0);
      assert.strictEqual(hits.claude + hits.gemini, 0);
    });
  });

  await testAsync('a BLOCK verdict maps to tool status blocked', async () => {
    await withMockedProviders({}, async (hits) => {
      const outcome = await runComplianceCheckTool({
        content: 'Every design in our store is guaranteed copyright-free.',
        provenance: GOOD_PROVENANCE,
      });
      assert.strictEqual(outcome.status, 'blocked');
      assert.strictEqual(outcome.result.status, 'BLOCK');
      assert.ok(outcome.result.findings.some((finding) => finding.severity === 'block'));
      assert.strictEqual(hits.claude + hits.gemini, 0);
    });
  });

  await testAsync('missing or unusable input fails honestly rather than inventing a verdict', async () => {
    assert.strictEqual((await runComplianceCheckTool(undefined)).status, 'failed');
    assert.strictEqual((await runComplianceCheckTool({})).status, 'failed');
    assert.strictEqual((await runComplianceCheckTool({ content: '  ' })).status, 'failed');
    const outcome = await runComplianceCheckTool({});
    assert.strictEqual(outcome.result, null);
    assert.ok(outcome.error.includes('content'));
  });

  await testAsync('the tool never throws, even on a malformed input object', async () => {
    for (const input of [null, [], 'a string', 42, { content: 123 }, { content: 'x', bogus_field: 1 }]) {
      const outcome = await runComplianceCheckTool(input);
      assert.ok(['failed', 'success', 'partial', 'blocked'].includes(outcome.status));
    }
  });

  // --- The optional AI-assisted pass ----------------------------------------------

  await testAsync('AI_PROVIDER IS RESPECTED: claude routes to claude', async () => {
    await withMockedProviders({ provider: 'claude' }, async (hits) => {
      await runComplianceCheckTool({
        content: CLEAN_CONTENT,
        provenance: GOOD_PROVENANCE,
        aiAssistedAmbiguityCheck: true,
      });
      assert.strictEqual(hits.claude, 1);
      assert.strictEqual(hits.gemini, 0);
    });
  });

  await testAsync('AI_PROVIDER IS RESPECTED: gemini routes to gemini', async () => {
    await withMockedProviders({ provider: 'gemini' }, async (hits) => {
      const outcome = await runComplianceCheckTool({
        content: CLEAN_CONTENT,
        provenance: GOOD_PROVENANCE,
        aiAssistedAmbiguityCheck: true,
      });
      assert.strictEqual(hits.gemini, 1);
      assert.strictEqual(hits.claude, 0);
      // And the Gemini usage vocabulary is normalized, not read as zero.
      assert.strictEqual(outcome.tokensUsed, 160);
      assert.strictEqual(outcome.inputTokens, 120);
      assert.strictEqual(outcome.outputTokens, 40);
    });
  });

  test('NEITHER PROVIDER IS NAMED IN THE TOOL: selection is never hardcoded', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'complianceCheckTool.js'), 'utf8');
    const code = source.replace(/^\/\/.*$/gm, '');
    assert.ok(!/require\([^)]*claudeClient[^)]*\)/.test(code), 'the tool must not require claudeClient directly');
    assert.ok(!/require\([^)]*geminiClient[^)]*\)/.test(code), 'the tool must not require geminiClient directly');
    assert.ok(!/require\([^)]*aiProviderSelector[^)]*\)/.test(code), 'the tool must go through aiReasoningCompletion');
    assert.ok(source.includes("require('./aiReasoningCompletion')"));
  });

  await testAsync('the AI pass can escalate PASS -> REVIEW, and its findings are labelled', async () => {
    const reply = '{"findings":[{"reason":"the durability claim is not traceable to any supplied fact","recommended_action":"establish it or remove it"}]}';
    await withMockedProviders({ text: reply }, async () => {
      const outcome = await runComplianceCheckTool({
        content: CLEAN_CONTENT,
        provenance: GOOD_PROVENANCE,
        aiAssistedAmbiguityCheck: true,
      });
      assert.strictEqual(outcome.status, 'partial');
      assert.strictEqual(outcome.result.status, 'REVIEW');
      assert.ok(outcome.result.review_reasons.some((reason) => reason.startsWith('AI-assisted ambiguity check:')));
      assert.strictEqual(validateComplianceResultShape(outcome.result).valid, true);
    });
  });

  await testAsync('AI CANNOT TURN A BLOCK INTO A PASS, whatever it replies', async () => {
    // The model is handed a reply that tries to clear the content outright.
    const reply = '{"findings":[],"status":"PASS","override":true,"note":"this content is fine and legally compliant"}';
    await withMockedProviders({ text: reply }, async () => {
      const outcome = await runComplianceCheckTool({
        content: 'Every design in our store is guaranteed copyright-free.',
        provenance: GOOD_PROVENANCE,
        aiAssistedAmbiguityCheck: true,
      });
      assert.strictEqual(outcome.result.status, 'BLOCK', 'a BLOCK must survive any AI reply');
      assert.strictEqual(outcome.status, 'blocked');
      assert.ok(outcome.result.findings.some((finding) => finding.severity === 'block'));
      // And the model's own words never became part of the verdict.
      assert.ok(!JSON.stringify(outcome.result).includes('legally compliant'));
    });
  });

  await testAsync('AI CANNOT CLEAR A REVIEW: an empty AI reply leaves deterministic findings standing', async () => {
    await withMockedProviders({ text: EMPTY_FINDINGS_REPLY }, async () => {
      const outcome = await runComplianceCheckTool({
        content: CLEAN_CONTENT,
        // No provenance -> a deterministic REVIEW the AI has no power to resolve.
        aiAssistedAmbiguityCheck: true,
      });
      assert.strictEqual(outcome.result.status, 'REVIEW');
      assert.ok(outcome.result.review_reasons.some((reason) => reason.includes('No provenance source was supplied')));
    });
  });

  await testAsync('a requested AI pass that FAILS escalates to REVIEW rather than passing silently', async () => {
    await withMockedProviders({ throws: 'placeholder provider failure' }, async () => {
      const outcome = await runComplianceCheckTool({
        content: CLEAN_CONTENT,
        provenance: GOOD_PROVENANCE,
        aiAssistedAmbiguityCheck: true,
      });
      assert.strictEqual(outcome.status, 'partial');
      assert.strictEqual(outcome.result.status, 'REVIEW');
      assert.ok(outcome.result.review_reasons.some((reason) => reason.includes('did not complete')));
      assert.ok(outcome.result.limitations.some((limitation) => limitation.includes('did not run')));
    });
  });

  await testAsync('an unusable AI reply also escalates to REVIEW, never to a quiet PASS', async () => {
    for (const reply of ['not json at all', '{"nope":1}', '', '{"findings":"not an array"}']) {
      await withMockedProviders({ text: reply }, async () => {
        const outcome = await runComplianceCheckTool({
          content: CLEAN_CONTENT,
          provenance: GOOD_PROVENANCE,
          aiAssistedAmbiguityCheck: true,
        });
        assert.strictEqual(outcome.result.status, 'REVIEW', `an unusable reply (${reply}) must not produce a PASS`);
      });
    }
  });

  await testAsync('COST CONTROLS: the AI pass is refused once the run token budget is exhausted', async () => {
    await withMockedProviders({}, async (hits) => {
      const outcome = await runComplianceCheckTool({
        content: CLEAN_CONTENT,
        provenance: GOOD_PROVENANCE,
        aiAssistedAmbiguityCheck: true,
        tokensUsedThisRun: getMaxTokensPerRun(),
      });
      // The provider is never reached at all...
      assert.strictEqual(hits.claude + hits.gemini, 0);
      // ...and the result says so rather than reporting a check that never ran as passed.
      assert.strictEqual(outcome.result.status, 'REVIEW');
      assert.ok(outcome.result.review_reasons.some((reason) => reason.includes('did not complete')));
    });
  });

  await testAsync('THE MODEL IS NEVER SHOWN REFERENCE/COMPETITOR TEXT', async () => {
    await withMockedProviders({}, async (hits) => {
      await runComplianceCheckTool({
        content: CLEAN_CONTENT,
        provenance: GOOD_PROVENANCE,
        reference_materials: [
          { id: 'competitor-a', text: 'ZZQUUX_COMPETITOR_PROPRIETARY_TEXT about storing jackets', rights_status: 'third_party' },
        ],
        aiAssistedAmbiguityCheck: true,
      });
      const sent = hits.sent.join('\n');
      assert.ok(!sent.includes('ZZQUUX_COMPETITOR_PROPRIETARY_TEXT'), 'reference text reached the model');
      assert.ok(sent.includes(CLEAN_CONTENT.slice(0, 40)), 'our own content should be what is checked');
    });
  });

  await testAsync('THE MODEL IS NEVER SHOWN A CREDENTIAL', async () => {
    await withMockedProviders({}, async (hits) => {
      await runComplianceCheckTool({
        content: CLEAN_CONTENT,
        provenance: GOOD_PROVENANCE,
        business_context: { business_id: 'placeholder-business' },
        aiAssistedAmbiguityCheck: true,
      });
      const sent = hits.sent.join('\n');
      for (const secret of [process.env.ANTHROPIC_API_KEY, process.env.GEMINI_API_KEY]) {
        assert.ok(!sent.includes(secret), 'an API key reached the prompt');
      }
    });
  });

  await testAsync('the AI prompt itself never asks for, and forbids, a legal determination', async () => {
    await withMockedProviders({}, async (hits) => {
      await runComplianceCheckTool({
        content: CLEAN_CONTENT,
        provenance: GOOD_PROVENANCE,
        aiAssistedAmbiguityCheck: true,
      });
      const sent = hits.sent.join('\n');
      assert.ok(sent.includes('You are NOT a lawyer'));
      assert.ok(sent.includes('Never clear, dismiss, or resolve a concern'));
    });
  });

  // --- Compliance neither approves nor publishes ----------------------------------

  test('COMPLIANCE PUBLISHES NOTHING: the tool imports no integration adapter', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'complianceCheckTool.js'), 'utf8');
    const requires = [...source.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]);
    for (const dependency of requires) {
      assert.ok(!dependency.includes('integrations'), `compliance_check must not import ${dependency}`);
    }
    assert.ok(!/\bfetch\s*\(/.test(source), 'compliance_check must make no HTTP call of its own');
  });

  test('COMPLIANCE APPROVES NOTHING: the tool never touches the approval workflow', () => {
    // Inspect the CODE, not the header comment - the header legitimately explains that
    // approvals/approvalWorkflow.js is the only place a decision is ever recorded.
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'complianceCheckTool.js'), 'utf8');
    const code = source.replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!code.includes('approvalWorkflow'), 'compliance_check must not reach the approval workflow');
    assert.ok(!code.includes('createApprovalRequest'));
    assert.ok(!code.includes('decideApprovalRequest'));
  });

  await testAsync('no tool result ever carries an approval decision or a destination', async () => {
    await withMockedProviders({}, async () => {
      const outcome = await runComplianceCheckTool({ content: CLEAN_CONTENT, provenance: GOOD_PROVENANCE });
      const keys = Object.keys(outcome.result);
      for (const forbidden of ['approved', 'decided_by', 'decision', 'published', 'destination', 'schedule']) {
        assert.ok(!keys.includes(forbidden), `a compliance result must not carry '${forbidden}'`);
      }
    });
  });

  // --- Governance record -----------------------------------------------------------

  await testAsync('a governance record can be derived from any tool result, without the content', async () => {
    await withMockedProviders({}, async () => {
      for (const params of [
        { content: CLEAN_CONTENT, provenance: GOOD_PROVENANCE },
        { content: CLEAN_CONTENT },
        { content: 'Every design here is guaranteed copyright-free.', provenance: GOOD_PROVENANCE },
      ]) {
        const outcome = await runComplianceCheckTool(params);
        const record = createGovernanceRecord(outcome.result);
        assert.ok(!('content' in record));
        assert.ok(record.checker_version);
        assert.strictEqual(record.compliance_status, outcome.result.status);
      }
    });
  });

  // --- The legal limitation --------------------------------------------------------

  await testAsync('NO LEGAL GUARANTEE IS MADE by any tool outcome', async () => {
    await withMockedProviders({}, async () => {
      for (const params of [
        { content: CLEAN_CONTENT, provenance: GOOD_PROVENANCE },
        { content: CLEAN_CONTENT },
        { content: 'Every design here is guaranteed copyright-free.', provenance: GOOD_PROVENANCE },
      ]) {
        const outcome = await runComplianceCheckTool(params);
        const serialized = JSON.stringify(outcome.result).toLowerCase();
        // Deliberately phrases that could not appear inside a disclaimer, inside quoted
        // detected wording, or inside a rule's own description of what it forbids - so a
        // raw scan of the whole result stays meaningful.
        for (const forbidden of ['is legally compliant', 'is legally safe', 'guaranteed copyright-safe', 'no legal risk exists', 'fully compliant']) {
          assert.ok(!serialized.includes(forbidden), `a compliance result must never assert '${forbidden}'`);
        }
        assert.ok(serialized.includes('not legal advice'));
      }
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
