'use strict';

const assert = require('node:assert');
const {
  understandObjective,
  identifyRequiredCapability,
  needsMoreInformation,
  createExecutionRequest,
  selectSpecialist,
  gatherMinimumContext,
  executeSelectedCapability,
  validateResult,
  runOrchestratorContract,
} = require('../../agent/core/orchestratorExecutionContract');

// This test never makes a real network call - the one real tool it can reach
// (business_configuration_retrieval) fails fast on its own "not configured" check
// before any fetch happens, matching the convention already used in
// shopifyClient.test.js and businessConfigurationRetrieval.test.js. Env vars are
// saved/restored around the one case that depends on them being unset.

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

test('understandObjective rejects a non-string task', () => {
  assert.throws(() => understandObjective(42), /non-empty task string/);
});

test('understandObjective rejects an empty/whitespace task', () => {
  assert.throws(() => understandObjective('   '), /non-empty task string/);
});

test('understandObjective trims and collapses whitespace', () => {
  assert.strictEqual(understandObjective('  find   products  '), 'find products');
});

test('identifyRequiredCapability matches a configuration-shaped task', () => {
  const capability = identifyRequiredCapability("check my shop's business configuration");
  assert.ok(capability, 'expected a capability match');
  assert.strictEqual(capability.tool.id, 'business_configuration_retrieval');
  assert.strictEqual(capability.category, 'configuration');
});

test('identifyRequiredCapability matches a products-shaped task', () => {
  const capability = identifyRequiredCapability('run product research on my catalog');
  assert.ok(capability, 'expected a capability match');
  assert.strictEqual(capability.category, 'products');
});

test('identifyRequiredCapability returns null for an unmatchable task', () => {
  assert.strictEqual(identifyRequiredCapability('zzqxvth wobble unicorn'), null);
});

test('needsMoreInformation is true when no capability matched', () => {
  const result = needsMoreInformation('zzqxvth wobble unicorn', null);
  assert.strictEqual(result.needs_more_information, true);
});

test('needsMoreInformation is false when a capability matched', () => {
  const capability = identifyRequiredCapability("check my shop's business configuration");
  const result = needsMoreInformation("check my shop's business configuration", capability);
  assert.strictEqual(result.needs_more_information, false);
  assert.strictEqual(result.reason, null);
});

test('createExecutionRequest routes a configuration-category match to shared infrastructure', () => {
  const capability = identifyRequiredCapability("check my shop's business configuration");
  const request = createExecutionRequest("check my shop's business configuration", capability);
  assert.strictEqual(request.is_shared_infrastructure, true);
  assert.strictEqual(request.specialist_id, null);
});

test('createExecutionRequest routes a products-category match to the product specialist', () => {
  const capability = identifyRequiredCapability('run product research on my catalog');
  const request = createExecutionRequest('run product research on my catalog', capability);
  assert.strictEqual(request.is_shared_infrastructure, false);
  assert.strictEqual(request.specialist_id, 'product');
});

test('selectSpecialist returns shared_infrastructure for a shared-infra request', () => {
  const capability = identifyRequiredCapability("check my shop's business configuration");
  const request = createExecutionRequest("check my shop's business configuration", capability);
  const specialist = selectSpecialist(request);
  assert.strictEqual(specialist.type, 'shared_infrastructure');
});

test('selectSpecialist returns the product specialist with its honest not_implemented status', () => {
  const capability = identifyRequiredCapability('run product research on my catalog');
  const request = createExecutionRequest('run product research on my catalog', capability);
  const specialist = selectSpecialist(request);
  assert.strictEqual(specialist.type, 'specialist');
  assert.strictEqual(specialist.id, 'product');
  assert.strictEqual(specialist.status, 'not_implemented');
});

test('gatherMinimumContext returns only the relevant boundary entries, not all six', () => {
  const capability = identifyRequiredCapability("check my shop's business configuration");
  const request = createExecutionRequest("check my shop's business configuration", capability);
  const context = gatherMinimumContext(request);
  const ids = context.map((boundary) => boundary.id);
  assert.ok(ids.includes('tool_context'));
  assert.ok(ids.includes('business_context'));
  assert.ok(!ids.includes('product_context'));
  assert.ok(context.length < 6);
});

test('validateResult marks a well-formed success outcome as passed', () => {
  assert.strictEqual(validateResult({ status: 'success', data: { name: 'x' }, error: null }), 'passed');
});

test('validateResult marks an error outcome as failed', () => {
  assert.strictEqual(validateResult({ status: 'error', data: null, error: 'boom' }), 'failed');
});

test('validateResult marks a not_available outcome as unverified', () => {
  assert.strictEqual(validateResult({ status: 'not_available', data: null, error: 'not built yet' }), 'unverified');
});

test('validateResult marks a malformed outcome as failed', () => {
  assert.strictEqual(validateResult(null), 'failed');
  assert.strictEqual(validateResult({}), 'failed');
});

(async () => {
  await testAsync('executeSelectedCapability returns not_available for an unimplemented tool', async () => {
    const capability = identifyRequiredCapability('run product research on my catalog');
    const request = createExecutionRequest('run product research on my catalog', capability);
    const outcome = await executeSelectedCapability(request);
    assert.strictEqual(outcome.status, 'not_available');
    assert.ok(outcome.error.includes('not yet implemented'));
  });

  await testAsync('executeSelectedCapability surfaces the clear not-configured error for business_configuration_retrieval, without crashing', async () => {
    const savedDomain = process.env.SHOPIFY_STORE_DOMAIN;
    const savedToken = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    delete process.env.SHOPIFY_STORE_DOMAIN;
    delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    try {
      const capability = identifyRequiredCapability("check my shop's business configuration");
      const request = createExecutionRequest("check my shop's business configuration", capability);
      const outcome = await executeSelectedCapability(request);
      assert.strictEqual(outcome.status, 'error');
      assert.ok(/SHOPIFY_STORE_DOMAIN/.test(outcome.error));
    } finally {
      if (savedDomain === undefined) delete process.env.SHOPIFY_STORE_DOMAIN;
      else process.env.SHOPIFY_STORE_DOMAIN = savedDomain;
      if (savedToken === undefined) delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
      else process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = savedToken;
    }
  });

  await testAsync('runOrchestratorContract: an empty task needs more information and never throws', async () => {
    const response = await runOrchestratorContract('');
    assert.strictEqual(response.needs_more_information, true);
    assert.strictEqual(response.outcome, null);
  });

  await testAsync('runOrchestratorContract: an unmatchable task needs more information', async () => {
    const response = await runOrchestratorContract('zzqxvth wobble unicorn');
    assert.strictEqual(response.needs_more_information, true);
    assert.strictEqual(response.capability, null);
  });

  await testAsync('runOrchestratorContract: a products-domain task identifies the specialist honestly as not available', async () => {
    const response = await runOrchestratorContract('run product research on my catalog');
    assert.strictEqual(response.needs_more_information, false);
    assert.strictEqual(response.specialist.type, 'specialist');
    assert.strictEqual(response.specialist.id, 'product');
    assert.strictEqual(response.outcome.status, 'not_available');
    assert.strictEqual(response.verification_status, 'unverified');
  });

  await testAsync('runOrchestratorContract: a configuration-domain task attempts the real tool and reports its result cleanly', async () => {
    const savedDomain = process.env.SHOPIFY_STORE_DOMAIN;
    const savedToken = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    delete process.env.SHOPIFY_STORE_DOMAIN;
    delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    try {
      const response = await runOrchestratorContract("check my shop's business configuration");
      assert.strictEqual(response.needs_more_information, false);
      assert.strictEqual(response.specialist.type, 'shared_infrastructure');
      assert.strictEqual(response.outcome.status, 'error');
      assert.ok(/SHOPIFY_STORE_DOMAIN/.test(response.outcome.error));
      assert.strictEqual(response.verification_status, 'failed');
      assert.strictEqual(response.state.task_status, 'failed');
    } finally {
      if (savedDomain === undefined) delete process.env.SHOPIFY_STORE_DOMAIN;
      else process.env.SHOPIFY_STORE_DOMAIN = savedDomain;
      if (savedToken === undefined) delete process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
      else process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = savedToken;
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();
