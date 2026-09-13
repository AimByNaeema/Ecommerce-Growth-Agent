'use strict';

// The controlled autonomy policy: agent/core/autonomyPolicy.js plus the cross-run budget
// read it depends on, agent/core/dailyUsageAccounting.js.
//
// NO EXTERNAL API IS CALLED ANYWHERE HERE, and none can be: the policy performs no
// adapter call by construction, and every fixture is a temp directory or an in-process
// object. The run records the daily budget is summed from are written by
// agent/core/runHistoryStore.js itself, so the numbers under test travel the same path
// real usage does.
//
// THE APPROVAL IS REAL. The human-approved cases below sign with a real Ed25519 key
// (approvalSigningTestKey.js) and go through the real, unmodified decideApprovalRequest()
// - nothing about approval is mocked, so "the existing approved-execution path still
// works" is evidence rather than assertion.
//
// THE KILL SWITCH IS PROCESS STATE, so every test that touches it sets it explicitly and
// restores it in a finally. No test may depend on the value another test left behind.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const autonomyPolicy = require('../../agent/core/autonomyPolicy');
const {
  AUTONOMY_KILL_SWITCH_ENV,
  POLICY_DECISIONS,
  POLICY_GATES,
  POLICY_REASON_CODES,
  readKillSwitch,
  getDefaultDailyTokenBudget,
  resolveBusinessPolicy,
  readVerifiedApproval,
  evaluateAutonomyPolicy,
} = autonomyPolicy;
const { readDailyUsage, utcDayKey } = require('../../agent/core/dailyUsageAccounting');
const runHistoryStore = require('../../agent/core/runHistoryStore');
const { createApprovalRequest, decideApprovalRequest } = require('../../approvals/approvalWorkflow');
const { useApprovalTestKey, signApproval } = require('./approvalSigningTestKey');
const { getMaxTokensPerRun } = require('../../agent/core/tokenControls');
const { createUsageTracker, getMaxToolCallsPerRun } = require('../../agent/core/usageLimits');

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

// ---------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------

// Same convention as businessRegistry.test.js: real temporary subdirectories under the
// registry's own fixed root, removed in a finally.
const BUSINESSES_ROOT = path.join(__dirname, '..', '..', 'configuration', 'businesses');

function withKillSwitch(value, fn) {
  const saved = process.env[AUTONOMY_KILL_SWITCH_ENV];
  if (value === undefined) delete process.env[AUTONOMY_KILL_SWITCH_ENV];
  else process.env[AUTONOMY_KILL_SWITCH_ENV] = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[AUTONOMY_KILL_SWITCH_ENV];
    else process.env[AUTONOMY_KILL_SWITCH_ENV] = saved;
  }
}

function withEnv(vars, fn) {
  const saved = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    process.env[key] = vars[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function withTempBusiness(id, businessYaml, fn) {
  const dir = path.join(BUSINESSES_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'business.yaml'), businessYaml);
  try {
    return fn();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function withTempRunStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-policy-runs-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function businessYaml({ platforms = '[shopify, etsy]', autonomy = 'enabled: true' } = {}) {
  return `
business_name: "Policy Test Co"
business_model: "D2C"
platform: "Shopify"
product_model: "in-house"
target_markets: ["US"]
countries: ["US"]
currencies: ["USD"]
product_categories: ["home"]
customer_segments: ["homeowners"]
brand:
  name: "Policy Test"
business_goals: ["grow"]
marketing_channels: ["email"]
enabled_platforms: ${platforms}
autonomy:
  ${autonomy}
`;
}

// A saved run carrying a real usage-ledger summary, in the exact shape
// usage/usageTracker.js's summarizeUsage() produces and server.js already reads.
function saveRun(storeDir, { runId, businessId, tokens, createdAt }) {
  runHistoryStore.saveRunRecord(
    {
      run_id: runId,
      business_id: businessId,
      kind: 'orchestrate',
      status: 'success',
      created_at: createdAt,
      result: {
        usage_summary: {
          by_category: {
            model_call: { count: 1, tokens_input: 0, tokens_output: tokens, tokens_total: tokens },
            tool_call: { count: 1 },
          },
        },
      },
    },
    { storeDir }
  );
}

// A policy request with every gate satisfied. Individual tests override one field at a
// time so a failure names exactly which gate produced it.
const PASSING_POLICY = {
  ok: true,
  business_id: null,
  enabled_platforms: ['shopify', 'etsy'],
  autonomy: { enabled: true, daily_token_budget: 10000, daily_run_budget: null },
};
const PASSING_DAILY = { available: true, day: '2026-01-01', tokens_total: 10, runs_counted: 1, runs_missing_usage: 0, coverage_complete: true };

function request(overrides = {}) {
  return {
    businessId: null,
    specialistId: 'research',
    toolId: 'market_research',
    complianceVerdict: 'PASS',
    businessPolicy: PASSING_POLICY,
    dailyUsage: PASSING_DAILY,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------------

test('the three decisions and the gate order are exactly as documented', () => {
  assert.deepStrictEqual(POLICY_DECISIONS, ['ALLOW', 'APPROVAL_REQUIRED', 'BLOCK']);
  assert.deepStrictEqual(
    POLICY_GATES.map((gate) => gate.id),
    [
      'business_identity',
      'policy_data',
      'compliance',
      'tool_authorization',
      'platform_enablement',
      'per_run_budget',
      'daily_budget',
      'autonomy_permission',
      'human_approval',
    ]
  );
  // Budget is evaluated before the autonomy and approval gates, so an exhausted budget
  // stops an action BEFORE the consequential step, never after it.
  const ids = POLICY_GATES.map((gate) => gate.id);
  assert.ok(ids.indexOf('daily_budget') < ids.indexOf('autonomy_permission'));
  assert.ok(ids.indexOf('per_run_budget') < ids.indexOf('human_approval'));
});

test('every reason code a decision can carry is declared', () => {
  const seen = new Set();
  const record = (result) => seen.add(result.reason_code);
  withKillSwitch('true', () => {
    record(evaluateAutonomyPolicy(request()));
    record(evaluateAutonomyPolicy(request({ toolId: 'shopify_vendor_correction', specialistId: 'product' })));
    record(evaluateAutonomyPolicy(request({ complianceVerdict: 'BLOCK' })));
    record(evaluateAutonomyPolicy(request({ complianceVerdict: null })));
    record(evaluateAutonomyPolicy(request({ toolId: 'etsy_shop_data_retrieval', specialistId: 'research' })));
    record(evaluateAutonomyPolicy(request({ platform: 'amazon' })));
    record(evaluateAutonomyPolicy(request({ runUsage: { tokensUsedThisRun: getMaxTokensPerRun() } })));
    record(evaluateAutonomyPolicy(request({ dailyUsage: { available: true, day: '2026-01-01', tokens_total: 99999, runs_counted: 1 } })));
    record(evaluateAutonomyPolicy(request({ dailyUsage: { available: false } })));
    record(evaluateAutonomyPolicy(request({ businessId: 'not a valid id' })));
  });
  withKillSwitch('false', () => record(evaluateAutonomyPolicy(request())));
  withKillSwitch('maybe', () => record(evaluateAutonomyPolicy(request())));
  for (const code of seen) {
    assert.ok(POLICY_REASON_CODES.includes(code), `undeclared reason code: ${code}`);
  }
  assert.ok(seen.size >= 10, `expected the sweep to reach most codes, reached ${seen.size}`);
});

// ---------------------------------------------------------------------------------
// The kill switch
// ---------------------------------------------------------------------------------

test('kill switch: only an unambiguous value reads as on', () => {
  for (const value of ['true', 'TRUE', ' true ', '1', 'on', 'yes', 'enabled']) {
    withKillSwitch(value, () => assert.strictEqual(readKillSwitch().state, 'on', `expected '${value}' to read as on`));
  }
});

test('kill switch: explicit negatives, blank and unset all read as off', () => {
  for (const value of ['false', 'FALSE', '0', 'off', 'no', 'disabled', '', '   ']) {
    withKillSwitch(value, () => assert.strictEqual(readKillSwitch().state, 'off', `expected '${value}' to read as off`));
  }
  withKillSwitch(undefined, () => {
    const state = readKillSwitch();
    assert.strictEqual(state.state, 'off');
    assert.strictEqual(state.value_present, false);
  });
});

test('kill switch: an unrecognized value is malformed, not silently off', () => {
  for (const value of ['ture', 'maybe', '1.0', 'ON!', 'true false']) {
    withKillSwitch(value, () => assert.strictEqual(readKillSwitch().state, 'malformed', `expected '${value}' to be malformed`));
  }
});

test('kill switch: the raw value never leaves readKillSwitch', () => {
  withKillSwitch('CANARY-KILL-SWITCH-VALUE', () => {
    assert.ok(!JSON.stringify(readKillSwitch()).includes('CANARY-KILL-SWITCH-VALUE'));
  });
});

// ---------------------------------------------------------------------------------
// REQUIRED PROOF: kill switch OFF blocks autonomous consequential execution
// ---------------------------------------------------------------------------------

test('kill switch OFF blocks autonomous consequential execution', () => {
  withKillSwitch('false', () => {
    const result = evaluateAutonomyPolicy(request({ toolId: 'shopify_vendor_correction', specialistId: 'product' }));
    assert.strictEqual(result.decision, 'BLOCK');
    assert.strictEqual(result.reason_code, 'kill_switch_off');
    assert.strictEqual(result.autonomous_execution_permitted, false);
  });
});

test('kill switch OFF also blocks an autonomous LOW-RISK action', () => {
  // A read still spends real budget and still burns a third party's quota, so the one
  // global stop stops everything the agent would start by itself.
  withKillSwitch('false', () => {
    const result = evaluateAutonomyPolicy(request());
    assert.strictEqual(result.decision, 'BLOCK');
    assert.strictEqual(result.reason_code, 'kill_switch_off');
  });
});

test('kill switch OFF blocks before the consequential action, not after it', () => {
  withKillSwitch('false', () => {
    const result = evaluateAutonomyPolicy(request({ toolId: 'shopify_vendor_correction', specialistId: 'product' }));
    assert.strictEqual(result.gates.autonomy_permission.status, 'block');
    // The approval gate was never even reached, so nothing downstream could have run.
    assert.strictEqual(result.gates.human_approval.status, 'skipped');
  });
});

// ---------------------------------------------------------------------------------
// REQUIRED PROOF: kill switch ON does not bypass approval
// ---------------------------------------------------------------------------------

test('kill switch ON does not bypass approval', () => {
  withKillSwitch('true', () => {
    const result = evaluateAutonomyPolicy(request({ toolId: 'shopify_vendor_correction', specialistId: 'product' }));
    assert.strictEqual(result.decision, 'APPROVAL_REQUIRED');
    assert.strictEqual(result.reason_code, 'human_approval_required');
    assert.strictEqual(result.human_approval_required, true);
    assert.strictEqual(result.autonomous_execution_permitted, false);
    // And it says, in the record itself, that it is not the authority on approval.
    assert.strictEqual(result.approval_gate_is_authoritative, true);
  });
});

test('autonomy permission can never manufacture or satisfy a human approval', () => {
  withKillSwitch('true', () => {
    const result = evaluateAutonomyPolicy(request({
      toolId: 'shopify_inventory_correction',
      specialistId: 'product',
      businessPolicy: { ...PASSING_POLICY, autonomy: { enabled: true, daily_token_budget: 10000, daily_run_budget: null } },
    }));
    assert.strictEqual(result.decision, 'APPROVAL_REQUIRED');
    assert.strictEqual(result.human_approval_present, false);
    assert.strictEqual(result.human_approval_request_id, null);
  });
});

test('an unverified or rejected approval object is not an approval', () => {
  assert.strictEqual(readVerifiedApproval(null), null);
  assert.strictEqual(readVerifiedApproval({ verified: false, provenance: { decision: 'approved' } }), null);
  assert.strictEqual(readVerifiedApproval({ verified: true }), null);
  assert.strictEqual(readVerifiedApproval({ verified: true, provenance: { decision: 'rejected' } }), null);
  assert.strictEqual(readVerifiedApproval({ verified: 'true', provenance: { decision: 'approved' } }), null);
  withKillSwitch('false', () => {
    const result = evaluateAutonomyPolicy(request({
      toolId: 'shopify_vendor_correction',
      specialistId: 'product',
      humanApproval: { verified: false, provenance: { decision: 'approved', request_id: 'forged' } },
    }));
    assert.strictEqual(result.decision, 'BLOCK');
    assert.strictEqual(result.reason_code, 'kill_switch_off');
  });
});

// ---------------------------------------------------------------------------------
// REQUIRED PROOF: compliance BLOCK always blocks
// ---------------------------------------------------------------------------------

test('compliance BLOCK always blocks - kill switch on, low risk, everything else passing', () => {
  withKillSwitch('true', () => {
    const result = evaluateAutonomyPolicy(request({ complianceVerdict: 'BLOCK' }));
    assert.strictEqual(result.decision, 'BLOCK');
    assert.strictEqual(result.reason_code, 'compliance_block');
  });
});

test('compliance BLOCK outranks even a verified human approval', () => {
  withKillSwitch('true', () => {
    const result = evaluateAutonomyPolicy(request({
      complianceVerdict: 'BLOCK',
      humanApproval: { verified: true, provenance: { decision: 'approved', request_id: 'req-1', method: 'ed25519_signature' } },
    }));
    assert.strictEqual(result.decision, 'BLOCK');
    assert.strictEqual(result.reason_code, 'compliance_block');
  });
});

test('compliance REVIEW can never reach ALLOW, even for a low-risk action', () => {
  withKillSwitch('true', () => {
    const result = evaluateAutonomyPolicy(request({ complianceVerdict: 'REVIEW' }));
    assert.strictEqual(result.decision, 'APPROVAL_REQUIRED');
    assert.strictEqual(result.reason_code, 'human_approval_required');
  });
});

test('an unstated compliance verdict is missing policy data, never a pass', () => {
  withKillSwitch('true', () => {
    for (const verdict of [null, undefined, '', 'pass', 'ok', true]) {
      const result = evaluateAutonomyPolicy(request({ complianceVerdict: verdict }));
      assert.strictEqual(result.decision, 'BLOCK', `verdict ${String(verdict)} should block`);
      assert.strictEqual(result.reason_code, 'compliance_verdict_missing');
    }
    // Only a deliberate declaration lets an action with no checkable content through.
    assert.strictEqual(evaluateAutonomyPolicy(request({ complianceVerdict: 'not_applicable' })).decision, 'ALLOW');
  });
});

// ---------------------------------------------------------------------------------
// REQUIRED PROOF: disabled platform blocks (and credentials never enable one)
// ---------------------------------------------------------------------------------

test('a disabled platform blocks even with that platform\'s credentials present', () => {
  withEnv(
    {
      ETSY_API_KEYSTRING: 'etsy-CANARY-DO-NOT-LEAK-3f9a7c2e',
      ETSY_OAUTH_ACCESS_TOKEN: 'etsy-token-CANARY-DO-NOT-LEAK-3f9a7c2e',
    },
    () => {
      withKillSwitch('true', () => {
        const shopifyOnly = { ...PASSING_POLICY, enabled_platforms: ['shopify'] };
        const result = evaluateAutonomyPolicy(request({
          // The Etsy read tools belong to Product's own categories, so Product is the
          // specialist that genuinely reaches the platform gate - a Research request would
          // be denied one gate earlier, on category, and would prove nothing about platforms.
          toolId: 'etsy_shop_data_retrieval',
          specialistId: 'product',
          businessPolicy: shopifyOnly,
        }));
        assert.strictEqual(result.decision, 'BLOCK');
        assert.strictEqual(result.reason_code, 'unauthorized_platform');
        assert.ok(!JSON.stringify(result).includes('CANARY'));
      });
    }
  );
});

test('an action naming an unrecognized or disabled platform fails closed', () => {
  withKillSwitch('true', () => {
    for (const platform of ['amazon', 'ebay', 'woocommerce', 'SHOPIFY']) {
      const result = evaluateAutonomyPolicy(request({ platform }));
      assert.strictEqual(result.decision, 'BLOCK', `platform ${platform} should block`);
      assert.strictEqual(result.reason_code, 'unauthorized_platform');
    }
    assert.strictEqual(evaluateAutonomyPolicy(request({ platform: 'shopify' })).decision, 'ALLOW');
  });
});

test('a business with no platform enabled denies every platform-bound tool', () => {
  withKillSwitch('true', () => {
    const nonePolicy = { ...PASSING_POLICY, enabled_platforms: [] };
    const bound = evaluateAutonomyPolicy(request({ toolId: 'product_data_retrieval', specialistId: 'product', businessPolicy: nonePolicy }));
    assert.strictEqual(bound.reason_code, 'unauthorized_platform');
    // A platform-neutral tool is unaffected - that is the whole point of the binding.
    assert.strictEqual(evaluateAutonomyPolicy(request({ businessPolicy: nonePolicy })).decision, 'ALLOW');
  });
});

// ---------------------------------------------------------------------------------
// REQUIRED PROOF: unauthorized tool blocks
// ---------------------------------------------------------------------------------

test('unauthorized tool blocks', () => {
  withKillSwitch('true', () => {
    // A real tool, outside this specialist's own category.
    const result = evaluateAutonomyPolicy(request({ specialistId: 'research', toolId: 'listing_content_generation' }));
    assert.strictEqual(result.decision, 'BLOCK');
    assert.strictEqual(result.reason_code, 'unauthorized_tool');
  });
});

test('an unknown tool blocks rather than defaulting to permitted', () => {
  withKillSwitch('true', () => {
    const result = evaluateAutonomyPolicy(request({ toolId: 'tool_that_does_not_exist' }));
    assert.strictEqual(result.decision, 'BLOCK');
    assert.strictEqual(result.reason_code, 'unauthorized_tool');
  });
});

// ---------------------------------------------------------------------------------
// REQUIRED PROOF: per-run budget blocks when exceeded
// ---------------------------------------------------------------------------------

test('per-run token budget blocks when exhausted', () => {
  withKillSwitch('true', () => {
    const result = evaluateAutonomyPolicy(request({ runUsage: { tokensUsedThisRun: getMaxTokensPerRun() } }));
    assert.strictEqual(result.decision, 'BLOCK');
    assert.strictEqual(result.reason_code, 'per_run_budget_exhausted');
    // Blocked before the approval gate was consulted at all.
    assert.strictEqual(result.gates.human_approval.status, 'skipped');
  });
});

test('per-run CALL budget blocks when exhausted, using the real usage tracker', () => {
  withKillSwitch('true', () => {
    const usageTracker = createUsageTracker();
    usageTracker.toolCalls = getMaxToolCallsPerRun();
    const result = evaluateAutonomyPolicy(request({ runUsage: { tokensUsedThisRun: 0, usageTracker } }));
    assert.strictEqual(result.decision, 'BLOCK');
    assert.strictEqual(result.reason_code, 'per_run_budget_exhausted');
  });
});

test('a fresh run with budget left passes the per-run gate', () => {
  withKillSwitch('true', () => {
    const result = evaluateAutonomyPolicy(request({ runUsage: { tokensUsedThisRun: 1, usageTracker: createUsageTracker() } }));
    assert.strictEqual(result.decision, 'ALLOW');
    assert.strictEqual(result.gates.per_run_budget.status, 'pass');
  });
});

// ---------------------------------------------------------------------------------
// REQUIRED PROOF: daily/cross-run budget blocks when exceeded
// ---------------------------------------------------------------------------------

test('daily token budget blocks when exceeded, summed from real saved runs', () => {
  withTempRunStore((storeDir) => {
    const now = new Date('2026-03-04T12:00:00.000Z');
    const today = '2026-03-04T09:00:00.000Z';
    saveRun(storeDir, { runId: 'day-1', businessId: 'budget-co', tokens: 700, createdAt: today });
    saveRun(storeDir, { runId: 'day-2', businessId: 'budget-co', tokens: 400, createdAt: today });

    const daily = readDailyUsage({ businessId: 'budget-co', now, storeDir });
    assert.strictEqual(daily.available, true);
    assert.strictEqual(daily.tokens_total, 1100);

    withKillSwitch('true', () => {
      const overBudget = { ...PASSING_POLICY, autonomy: { enabled: true, daily_token_budget: 1000, daily_run_budget: null } };
      const result = evaluateAutonomyPolicy(request({ businessPolicy: overBudget, dailyUsage: daily }));
      assert.strictEqual(result.decision, 'BLOCK');
      assert.strictEqual(result.reason_code, 'daily_budget_exhausted');

      // Same day's spend, a budget that accommodates it: allowed.
      const withinBudget = { ...PASSING_POLICY, autonomy: { enabled: true, daily_token_budget: 5000, daily_run_budget: null } };
      assert.strictEqual(evaluateAutonomyPolicy(request({ businessPolicy: withinBudget, dailyUsage: daily })).decision, 'ALLOW');
    });
  });
});

test('daily RUN budget blocks when exceeded, and is enforced only when configured', () => {
  const daily = { available: true, day: '2026-03-04', tokens_total: 5, runs_counted: 4, runs_missing_usage: 0, coverage_complete: true };
  withKillSwitch('true', () => {
    const capped = { ...PASSING_POLICY, autonomy: { enabled: true, daily_token_budget: 10000, daily_run_budget: 4 } };
    const blocked = evaluateAutonomyPolicy(request({ businessPolicy: capped, dailyUsage: daily }));
    assert.strictEqual(blocked.reason_code, 'daily_budget_exhausted');

    // No run ceiling configured: no invented default takes its place.
    const uncapped = { ...PASSING_POLICY, autonomy: { enabled: true, daily_token_budget: 10000, daily_run_budget: null } };
    assert.strictEqual(evaluateAutonomyPolicy(request({ businessPolicy: uncapped, dailyUsage: daily })).decision, 'ALLOW');
  });
});

test('the default daily token ceiling is derived from the per-run budget, never invented', () => {
  assert.strictEqual(getDefaultDailyTokenBudget(), getMaxTokensPerRun() * autonomyPolicy.DEFAULT_DAILY_RUN_ALLOWANCE);
  withKillSwitch('true', () => {
    const noBudgetStated = { ...PASSING_POLICY, autonomy: { enabled: true, daily_token_budget: null, daily_run_budget: null } };
    const atCeiling = { available: true, day: '2026-03-04', tokens_total: getDefaultDailyTokenBudget(), runs_counted: 1, runs_missing_usage: 0, coverage_complete: true };
    const result = evaluateAutonomyPolicy(request({ businessPolicy: noBudgetStated, dailyUsage: atCeiling }));
    assert.strictEqual(result.reason_code, 'daily_budget_exhausted');
    // Tokens, never money: no currency symbol or cost word appears in the decision.
    assert.ok(!/[$€£]|\bcost\b|\bprice\b/i.test(JSON.stringify(result)));
  });
});

test('yesterday\'s spend does not count against today', () => {
  withTempRunStore((storeDir) => {
    saveRun(storeDir, { runId: 'old-1', businessId: 'budget-co', tokens: 99999, createdAt: '2026-03-03T23:59:59.000Z' });
    saveRun(storeDir, { runId: 'new-1', businessId: 'budget-co', tokens: 5, createdAt: '2026-03-04T00:00:01.000Z' });
    const daily = readDailyUsage({ businessId: 'budget-co', now: new Date('2026-03-04T12:00:00.000Z'), storeDir });
    assert.strictEqual(daily.tokens_total, 5);
    assert.strictEqual(daily.runs_counted, 1);
    assert.strictEqual(daily.day, '2026-03-04');
  });
});

// ---------------------------------------------------------------------------------
// REQUIRED PROOF: one business cannot consume another business's budget
// ---------------------------------------------------------------------------------

test('one business cannot consume another business\'s budget', () => {
  withTempRunStore((storeDir) => {
    const now = new Date('2026-03-04T12:00:00.000Z');
    const today = '2026-03-04T09:00:00.000Z';
    // Business A blows its entire day.
    saveRun(storeDir, { runId: 'a-1', businessId: 'alpha-co', tokens: 500000, createdAt: today });

    const alpha = readDailyUsage({ businessId: 'alpha-co', now, storeDir });
    const beta = readDailyUsage({ businessId: 'beta-co', now, storeDir });
    assert.strictEqual(alpha.tokens_total, 500000);
    assert.strictEqual(beta.tokens_total, 0, "beta must not see alpha's spend");
    assert.strictEqual(beta.runs_counted, 0);

    withKillSwitch('true', () => {
      const policy = { ...PASSING_POLICY, autonomy: { enabled: true, daily_token_budget: 1000, daily_run_budget: null } };
      assert.strictEqual(evaluateAutonomyPolicy(request({ businessId: 'alpha-co', businessPolicy: policy, dailyUsage: alpha })).reason_code, 'daily_budget_exhausted');
      assert.strictEqual(evaluateAutonomyPolicy(request({ businessId: 'beta-co', businessPolicy: policy, dailyUsage: beta })).decision, 'ALLOW');
    });
  });
});

test('the default (null) business does not absorb every other business\'s spend', () => {
  withTempRunStore((storeDir) => {
    const now = new Date('2026-03-04T12:00:00.000Z');
    saveRun(storeDir, { runId: 'named-1', businessId: 'alpha-co', tokens: 400000, createdAt: '2026-03-04T09:00:00.000Z' });
    saveRun(storeDir, { runId: 'default-1', businessId: null, tokens: 12, createdAt: '2026-03-04T09:30:00.000Z' });
    const defaults = readDailyUsage({ businessId: null, now, storeDir });
    assert.strictEqual(defaults.tokens_total, 12);
    assert.strictEqual(defaults.runs_counted, 1);
  });
});

// ---------------------------------------------------------------------------------
// REQUIRED PROOF: missing/malformed policy config fails closed
// ---------------------------------------------------------------------------------

test('a malformed kill switch blocks under its own reason code', () => {
  withKillSwitch('ture', () => {
    const result = evaluateAutonomyPolicy(request());
    assert.strictEqual(result.decision, 'BLOCK');
    assert.strictEqual(result.reason_code, 'kill_switch_malformed');
    assert.strictEqual(result.gates.policy_data.status, 'block');
  });
});

test('an invalid business id blocks at the first gate', () => {
  withKillSwitch('true', () => {
    for (const id of ['not a valid id', '../escape', '!!']) {
      const result = evaluateAutonomyPolicy({ ...request(), businessId: id, businessPolicy: null, dailyUsage: PASSING_DAILY });
      assert.strictEqual(result.decision, 'BLOCK', `id '${id}' should block`);
      assert.strictEqual(result.reason_code, 'invalid_business');
    }
  });
});

test('a business with no readable configuration blocks as unreadable policy data', () => {
  withKillSwitch('true', () => {
    const result = evaluateAutonomyPolicy({ ...request(), businessId: 'no-such-business-here', businessPolicy: null });
    assert.strictEqual(result.decision, 'BLOCK');
    assert.strictEqual(result.reason_code, 'policy_data_unreadable');
  });
});

test('a malformed autonomy block blocks rather than being read as on or off', () => {
  withTempBusiness('policy-malformed-co', businessYaml({ autonomy: 'enabled: "true"' }), () => {
    const resolved = resolveBusinessPolicy('policy-malformed-co');
    assert.strictEqual(resolved.ok, false);
    assert.strictEqual(resolved.reason_code, 'policy_data_malformed');
    withKillSwitch('true', () => {
      const result = evaluateAutonomyPolicy({ ...request(), businessId: 'policy-malformed-co', businessPolicy: null });
      assert.strictEqual(result.decision, 'BLOCK');
      assert.strictEqual(result.reason_code, 'policy_data_malformed');
    });
  });
});

test('an unreadable run store is never read as an unspent budget', () => {
  withKillSwitch('true', () => {
    const result = evaluateAutonomyPolicy(request({ dailyUsage: { available: false, unavailable_reason: 'run_store_unreadable' } }));
    assert.strictEqual(result.decision, 'BLOCK');
    assert.strictEqual(result.reason_code, 'policy_data_unreadable');
  });
  withTempRunStore((storeDir) => {
    // A path that exists but is a file, not a directory.
    const notADir = path.join(storeDir, 'a-file.json');
    fs.writeFileSync(notADir, '{}');
    const daily = readDailyUsage({ businessId: 'x', storeDir: notADir });
    assert.strictEqual(daily.available, false);
    assert.strictEqual(daily.tokens_total, 0);
  });
});

test('a store that does not exist yet is an honest zero, not an error', () => {
  const daily = readDailyUsage({ businessId: 'x', storeDir: path.join(os.tmpdir(), 'autonomy-policy-never-created-dir') });
  assert.strictEqual(daily.available, true);
  assert.strictEqual(daily.tokens_total, 0);
  assert.strictEqual(daily.runs_counted, 0);
});

test('a corrupt run record is skipped without taking the day\'s total with it', () => {
  withTempRunStore((storeDir) => {
    const today = '2026-03-04T09:00:00.000Z';
    saveRun(storeDir, { runId: 'good-1', businessId: 'budget-co', tokens: 60, createdAt: today });
    fs.writeFileSync(path.join(storeDir, 'corrupt-1.json'), '{ this is not json');
    const daily = readDailyUsage({ businessId: 'budget-co', now: new Date('2026-03-04T12:00:00.000Z'), storeDir });
    assert.strictEqual(daily.available, true);
    assert.strictEqual(daily.tokens_total, 60);
  });
});

test('an undated run is reported, never dated into today by guesswork', () => {
  withTempRunStore((storeDir) => {
    saveRun(storeDir, { runId: 'undated-1', businessId: 'budget-co', tokens: 900, createdAt: 'not-a-timestamp' });
    const daily = readDailyUsage({ businessId: 'budget-co', now: new Date('2026-03-04T12:00:00.000Z'), storeDir });
    assert.strictEqual(daily.runs_undated, 1);
    assert.strictEqual(daily.tokens_total, 0);
  });
  assert.strictEqual(utcDayKey('nonsense'), null);
  assert.strictEqual(utcDayKey(null), null);
  assert.strictEqual(utcDayKey('2026-03-04T23:30:00.000Z'), '2026-03-04');
});

test('a run with no usage ledger contributes zero and is reported as uncovered', () => {
  withTempRunStore((storeDir) => {
    const today = '2026-03-04T09:00:00.000Z';
    saveRun(storeDir, { runId: 'with-usage', businessId: 'budget-co', tokens: 40, createdAt: today });
    runHistoryStore.saveRunRecord(
      { run_id: 'no-usage', business_id: 'budget-co', status: 'success', created_at: today, result: {} },
      { storeDir }
    );
    const daily = readDailyUsage({ businessId: 'budget-co', now: new Date('2026-03-04T12:00:00.000Z'), storeDir });
    assert.strictEqual(daily.runs_counted, 2);
    assert.strictEqual(daily.runs_with_usage, 1, 'coverage is reported, so the total is known to be a floor');
    assert.strictEqual(daily.tokens_total, 40);
  });
});

// ---------------------------------------------------------------------------------
// REQUIRED PROOFS: a valid low-risk action is ALLOWed; a consequential one is not
// ---------------------------------------------------------------------------------

test('a valid low-risk action is ALLOWed when every gate passes', () => {
  withKillSwitch('true', () => {
    const result = evaluateAutonomyPolicy(request());
    assert.strictEqual(result.decision, 'ALLOW');
    assert.strictEqual(result.reason_code, 'low_risk_autonomous_action_permitted');
    assert.strictEqual(result.autonomous_execution_permitted, true);
    assert.strictEqual(result.human_approval_required, false);
    for (const gate of ['business_identity', 'policy_data', 'compliance', 'tool_authorization', 'platform_enablement', 'per_run_budget', 'daily_budget', 'autonomy_permission', 'human_approval']) {
      assert.strictEqual(result.gates[gate].status, 'pass', `gate ${gate} should have passed`);
    }
  });
});

test('a business that has not enabled autonomy blocks even with the kill switch on', () => {
  withKillSwitch('true', () => {
    const disabled = { ...PASSING_POLICY, autonomy: { enabled: false, daily_token_budget: null, daily_run_budget: null } };
    const result = evaluateAutonomyPolicy(request({ businessPolicy: disabled }));
    assert.strictEqual(result.decision, 'BLOCK');
    assert.strictEqual(result.reason_code, 'business_autonomy_disabled');
  });
});

test('business autonomy is read from configuration and never inferred from credentials', () => {
  withEnv({ SHOPIFY_ADMIN_API_ACCESS_TOKEN: 'shpat_CANARY-DO-NOT-LEAK-3f9a7c2e' }, () => {
    withTempBusiness('policy-autonomy-off-co', businessYaml({ autonomy: 'enabled: false' }), () => {
      const resolved = resolveBusinessPolicy('policy-autonomy-off-co');
      assert.strictEqual(resolved.ok, true);
      assert.strictEqual(resolved.autonomy.enabled, false);
    });
    withTempBusiness('policy-autonomy-on-co', businessYaml({ autonomy: 'enabled: true' }), () => {
      assert.strictEqual(resolveBusinessPolicy('policy-autonomy-on-co').autonomy.enabled, true);
    });
    // An omitted autonomy block is off - an unstated permission was never granted.
    withTempBusiness('policy-autonomy-absent-co', businessYaml({ autonomy: 'enabled: false' }).replace(/autonomy:\n  enabled: false\n/, ''), () => {
      assert.strictEqual(resolveBusinessPolicy('policy-autonomy-absent-co').autonomy.enabled, false);
    });
  });
});

// ---------------------------------------------------------------------------------
// REQUIRED PROOF: the existing human-approved execution path remains functional
// ---------------------------------------------------------------------------------

test('a real Ed25519-signed approval still decides through the untouched approval workflow', () => {
  useApprovalTestKey(() => {
    const requests = [
      createApprovalRequest({
        id: 'policy-approval-1',
        classification: 'externally_executable',
        specialistId: 'product',
        toolId: 'shopify_vendor_correction',
        executionRequest: { objective: 'Correct one vendor field.', business_id: 'alpha-co' },
        reason: 'Changes a real product record in the connected store.',
      }),
    ];
    const authorization = signApproval({ request: requests[0], decision: 'approved', decidedBy: 'owner@example.com' });
    const decided = decideApprovalRequest(requests, 'policy-approval-1', {
      decision: 'approved',
      decidedBy: 'owner@example.com',
      authorization,
    });
    assert.strictEqual(decided[0].status, 'approved');
    const provenance = decided[0].execution_request.approval_provenance;
    assert.strictEqual(provenance.method, 'ed25519_signature');

    // That same real provenance drives the policy - and the kill switch, which stops the
    // agent acting on its OWN initiative, does not stop a human-approved action.
    withKillSwitch('false', () => {
      const result = evaluateAutonomyPolicy(request({
        toolId: 'shopify_vendor_correction',
        specialistId: 'product',
        humanApproval: { verified: true, provenance },
      }));
      assert.strictEqual(result.decision, 'ALLOW');
      assert.strictEqual(result.reason_code, 'human_approved');
      assert.strictEqual(result.human_approval_present, true);
      assert.strictEqual(result.human_approval_request_id, 'policy-approval-1');
      // It is still not autonomous execution - a human directed it.
      assert.strictEqual(result.autonomous_execution_permitted, false);
      assert.strictEqual(result.gates.autonomy_permission.status, 'skipped');
    });
  });
});

test('a human-approved action is still subject to every hard block', () => {
  const approval = { verified: true, provenance: { decision: 'approved', request_id: 'req-9', method: 'ed25519_signature' } };
  withKillSwitch('true', () => {
    const overBudget = { available: true, day: '2026-03-04', tokens_total: 999999, runs_counted: 1 };
    assert.strictEqual(
      evaluateAutonomyPolicy(request({ humanApproval: approval, dailyUsage: overBudget })).reason_code,
      'daily_budget_exhausted'
    );
    assert.strictEqual(
      evaluateAutonomyPolicy(request({ humanApproval: approval, toolId: 'etsy_shop_data_retrieval', specialistId: 'product', businessPolicy: { ...PASSING_POLICY, enabled_platforms: ['shopify'] } })).reason_code,
      'unauthorized_platform'
    );
  });
});

// ---------------------------------------------------------------------------------
// REQUIRED PROOF: no credentials, private keys or signatures leak into policy output
// ---------------------------------------------------------------------------------

test('no credential, key or signature reaches any policy decision', () => {
  const CANARIES = [
    'sk-ant-CANARY-DO-NOT-LEAK-3f9a7c2e',
    'shpat_CANARY-DO-NOT-LEAK-3f9a7c2e',
    'etsy-CANARY-DO-NOT-LEAK-3f9a7c2e',
    'agent-key-CANARY-DO-NOT-LEAK-3f9a7c2e',
    'CANARY-KILL-SWITCH-RAW-VALUE',
  ];

  useApprovalTestKey(() => {
    const requests = [
      createApprovalRequest({
        id: 'policy-approval-2',
        classification: 'externally_executable',
        specialistId: 'product',
        toolId: 'shopify_vendor_correction',
        executionRequest: { objective: 'Correct one vendor field.' },
        reason: 'Changes a real product record in the connected store.',
      }),
    ];
    const authorization = signApproval({ request: requests[0], decision: 'approved', decidedBy: 'owner@example.com' });
    const decided = decideApprovalRequest(requests, 'policy-approval-2', {
      decision: 'approved',
      decidedBy: 'owner@example.com',
      authorization,
    });
    const provenance = decided[0].execution_request.approval_provenance;
    // The provenance genuinely carries a signature - so this test is real.
    assert.ok(typeof provenance.signature === 'string' && provenance.signature.length > 0);

    withEnv(
      {
        ANTHROPIC_API_KEY: CANARIES[0],
        SHOPIFY_ADMIN_API_ACCESS_TOKEN: CANARIES[1],
        ETSY_API_KEYSTRING: CANARIES[2],
        AGENT_API_KEY: CANARIES[3],
      },
      () => {
        const decisions = [];
        const collect = (value) => decisions.push(value);
        withKillSwitch('true', () => {
          collect(evaluateAutonomyPolicy(request()));
          collect(evaluateAutonomyPolicy(request({ toolId: 'shopify_vendor_correction', specialistId: 'product' })));
          collect(evaluateAutonomyPolicy(request({ complianceVerdict: 'BLOCK' })));
          collect(evaluateAutonomyPolicy(request({ toolId: 'tool_that_does_not_exist' })));
          collect(evaluateAutonomyPolicy(request({ platform: 'amazon' })));
          collect(evaluateAutonomyPolicy(request({ runUsage: { tokensUsedThisRun: getMaxTokensPerRun() } })));
          collect(evaluateAutonomyPolicy(request({ dailyUsage: { available: true, day: '2026-03-04', tokens_total: 999999, runs_counted: 9 } })));
          collect(evaluateAutonomyPolicy({ ...request(), businessId: 'no-such-business-here', businessPolicy: null }));
          collect(evaluateAutonomyPolicy(request({
            toolId: 'shopify_vendor_correction',
            specialistId: 'product',
            humanApproval: { verified: true, provenance },
          })));
        });
        withKillSwitch(CANARIES[4], () => collect(evaluateAutonomyPolicy(request())));
        withKillSwitch('false', () => collect(evaluateAutonomyPolicy(request())));

        const serialized = JSON.stringify(decisions);
        for (const canary of CANARIES) {
          assert.ok(!serialized.includes(canary), `a decision leaked ${canary}`);
        }
        // The signature and the single-use nonce are read past, never carried out.
        assert.ok(!serialized.includes(provenance.signature), 'a decision leaked the approval signature');
        assert.ok(!serialized.includes(provenance.nonce), 'a decision leaked the approval nonce');
        // Every decision is still a real one, so this proved something.
        assert.strictEqual(decisions.length, 11);
        for (const decision of decisions) {
          assert.ok(POLICY_DECISIONS.includes(decision.decision));
        }
      }
    );
  });
});

// ---------------------------------------------------------------------------------
// The policy can never become a second approval mechanism
// ---------------------------------------------------------------------------------

test('agent/core/autonomyPolicy.js contains no cryptography of its own', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'agent', 'core', 'autonomyPolicy.js'), 'utf8');
  // Comments explain WHY there is no crypto here, so the scan looks at code only.
  const code = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  for (const forbidden of ["require('crypto')", "require('node:crypto')", 'createPrivateKey', 'createPublicKey', 'generateKeyPair', 'crypto.sign', 'crypto.verify']) {
    assert.ok(!code.includes(forbidden), `autonomyPolicy.js must not contain ${forbidden}`);
  }
  // And it must not reach for the verification function either - recognizing that
  // function's result is the whole of its involvement with approval.
  assert.ok(!code.includes('verifyApprovalAuthorization'));
});

test('the policy performs no network call and reads no credential', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'agent', 'core', 'autonomyPolicy.js'), 'utf8');
  const code = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  for (const forbidden of ['fetch(', 'shopifyClient', 'etsyReadClient', 'loadBusinessCredentials', 'CREDENTIAL_KEYS']) {
    assert.ok(!code.includes(forbidden), `autonomyPolicy.js must not contain ${forbidden}`);
  }
});

test('an unexpected fault during evaluation is a refusal, never a pass', () => {
  withKillSwitch('true', () => {
    // A businessPolicy object that throws the moment the policy reads it.
    const hostile = { ok: true, business_id: null, enabled_platforms: ['shopify'], get autonomy() { throw new Error('boom'); } };
    const result = evaluateAutonomyPolicy(request({ businessPolicy: hostile }));
    assert.strictEqual(result.decision, 'BLOCK');
    assert.strictEqual(result.reason_code, 'policy_evaluation_error');
    assert.ok(!JSON.stringify(result).includes('boom'), 'the underlying fault message is not relayed');
  });
});

// ---------------------------------------------------------------------------------
// REQUIRED PROOFS: missing usage can never become unlimited budget
// ---------------------------------------------------------------------------------

test('a run with no usage ledger is counted as unknown, never as zero cost', () => {
  withTempRunStore((storeDir) => {
    const now = new Date('2026-03-04T12:00:00.000Z');
    const today = '2026-03-04T09:00:00.000Z';
    saveRun(storeDir, { runId: 'with-usage', businessId: 'budget-co', tokens: 40, createdAt: today });
    runHistoryStore.saveRunRecord(
      { run_id: 'no-usage', business_id: 'budget-co', status: 'success', created_at: today, result: {} },
      { storeDir }
    );

    const daily = readDailyUsage({ businessId: 'budget-co', now, storeDir });
    assert.strictEqual(daily.runs_counted, 2);
    assert.strictEqual(daily.runs_with_usage, 1);
    assert.strictEqual(daily.runs_missing_usage, 1);
    assert.strictEqual(daily.tokens_total, 40, "the total is a floor, not a spend");
    assert.strictEqual(daily.coverage_complete, false, "incomplete coverage must be reported, not hidden");
  });
});

test('incomplete usage coverage BLOCKS rather than granting the remaining budget', () => {
  withKillSwitch('true', () => {
    // Far under budget on the measured floor - and still refused, because the real spend
    // is unknown. This is the bypass the gate exists to close.
    const incomplete = { available: true, day: '2026-03-04', tokens_total: 1, runs_counted: 9, runs_missing_usage: 8, coverage_complete: false };
    const result = evaluateAutonomyPolicy(request({ dailyUsage: incomplete }));
    assert.strictEqual(result.decision, 'BLOCK');
    assert.strictEqual(result.reason_code, 'daily_budget_unverifiable');
    assert.ok(/floor rather than a total/.test(result.reason));

    // Complete coverage at the same spend is allowed - the gate is about knowing, not about
    // being stricter with the number.
    const complete = { ...incomplete, runs_missing_usage: 0, coverage_complete: true };
    assert.strictEqual(evaluateAutonomyPolicy(request({ dailyUsage: complete })).decision, 'ALLOW');
  });
});

test('an over-budget floor is refused as exhausted even when coverage is incomplete', () => {
  withKillSwitch('true', () => {
    // Incompleteness can only ever hide MORE spend, so it can never rescue an over-budget
    // day - and the operator gets the more specific reason.
    const spent = { available: true, day: '2026-03-04', tokens_total: 999999, runs_counted: 9, runs_missing_usage: 8, coverage_complete: false };
    assert.strictEqual(evaluateAutonomyPolicy(request({ dailyUsage: spent })).reason_code, 'daily_budget_exhausted');
  });
});

test('malformed usage data lowers coverage rather than contributing a silent zero', () => {
  withTempRunStore((storeDir) => {
    const now = new Date('2026-03-04T12:00:00.000Z');
    const today = '2026-03-04T09:00:00.000Z';
    saveRun(storeDir, { runId: 'good', businessId: 'budget-co', tokens: 25, createdAt: today });
    // A usage_summary that is PRESENT but whose totals cannot be read.
    runHistoryStore.saveRunRecord(
      {
        run_id: 'malformed',
        business_id: 'budget-co',
        status: 'success',
        created_at: today,
        result: { usage_summary: { by_category: { model_call: { tokens_total: 'lots' } } } },
      },
      { storeDir }
    );

    const daily = readDailyUsage({ businessId: 'budget-co', now, storeDir });
    assert.strictEqual(daily.tokens_total, 25);
    assert.strictEqual(daily.runs_missing_usage, 1);
    assert.strictEqual(daily.coverage_complete, false);
    withKillSwitch('true', () => {
      assert.strictEqual(evaluateAutonomyPolicy(request({ dailyUsage: daily })).reason_code, 'daily_budget_unverifiable');
    });
  });
});

test('a fully instrumented day has complete coverage and aggregates correctly', () => {
  withTempRunStore((storeDir) => {
    const now = new Date('2026-03-04T12:00:00.000Z');
    const today = '2026-03-04T09:00:00.000Z';
    saveRun(storeDir, { runId: 'r1', businessId: 'budget-co', tokens: 100, createdAt: today });
    saveRun(storeDir, { runId: 'r2', businessId: 'budget-co', tokens: 250, createdAt: today });
    saveRun(storeDir, { runId: 'r3', businessId: 'budget-co', tokens: 7, createdAt: today });

    const daily = readDailyUsage({ businessId: 'budget-co', now, storeDir });
    assert.strictEqual(daily.tokens_total, 357);
    assert.strictEqual(daily.runs_counted, 3);
    assert.strictEqual(daily.runs_with_usage, 3);
    assert.strictEqual(daily.coverage_complete, true);

    // And it survives a restart: re-read from disk alone, nothing held in memory.
    const reloaded = readDailyUsage({ businessId: 'budget-co', now, storeDir });
    assert.deepStrictEqual(reloaded, daily);
  });
});

test('coverage is per business - one business\'s gap never blocks another', () => {
  withTempRunStore((storeDir) => {
    const now = new Date('2026-03-04T12:00:00.000Z');
    const today = '2026-03-04T09:00:00.000Z';
    saveRun(storeDir, { runId: 'beta-good', businessId: 'beta-co', tokens: 5, createdAt: today });
    runHistoryStore.saveRunRecord(
      { run_id: 'alpha-gap', business_id: 'alpha-co', status: 'success', created_at: today, result: {} },
      { storeDir }
    );

    assert.strictEqual(readDailyUsage({ businessId: 'alpha-co', now, storeDir }).coverage_complete, false);
    assert.strictEqual(readDailyUsage({ businessId: 'beta-co', now, storeDir }).coverage_complete, true, "beta must not inherit alpha's gap");
  });
});

test('this test file is registered in the suite runner', () => {
  const { TEST_FILES } = require('./runAllTests');
  assert.ok(TEST_FILES.includes('autonomyPolicy.test.js'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
