'use strict';

// CONTROLLED AUTONOMY IS MULTI-PLATFORM AT THE ARCHITECTURE LEVEL - AND HONEST ABOUT EACH ONE.
//
//   A. Core autonomy carries no platform literal in its runtime code.
//   B. Each platform's observation tools are declared at the platform registration point, and
//      the declaration is truthful.
//   C. The real, unmodified truth for Shopify, Etsy, Amazon and eBay at every layer.
//   D. An observation tool can never observe a platform it is not declared for.
//   E. A clearly SYNTHETIC test platform onboarded in memory - only through the registration
//      points (channel vocabulary, read adapter, tool registry + classification, observation
//      declaration, business configuration) - runs the whole autonomous loop with no edit to
//      the scheduler, policy, monitor, cycle or Chief. Each missing registration step refuses
//      at its own layer. Everything is restored afterwards.
//
// NOTHING ABOUT A REAL MARKETPLACE IS INVENTED. The synthetic platform is named so it cannot be
// mistaken for one, its data is fixture data, and Amazon/eBay are asserted only in their real
// state (no adapter, not enableable, not schedulable, never PASS). No network is reachable.

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
  process.env[variable] = fs.mkdtempSync(path.join(os.tmpdir(), `platform-generality-${name}-`));
  TEMP_DIRS.push(process.env[variable]);
}
delete process.env.VERCEL;

const BUSINESSES_ROOT = path.join(__dirname, '..', '..', 'configuration', 'businesses');
const FIXTURE_DIRS = [];
function writeBusiness(id, platforms) {
  const dir = path.join(BUSINESSES_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'business.yaml'),
    [
      `business_name: "${id}"`,
      'business_model: "D2C"',
      'platform: "Test"',
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
      `enabled_platforms: ${platforms}`,
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

const SYNTHETIC = 'synthetic-test-market';
const SYNTHETIC_TOOL = 'synthetic_market_listing_observation';
const SYNTH_BUSINESS = 'platform-generality-synth-co';
const MIXED_BUSINESS = 'platform-generality-mixed-co';
writeBusiness(SYNTH_BUSINESS, `[${SYNTHETIC}]`);
writeBusiness(MIXED_BUSINESS, '[shopify, etsy]');

const channelModel = require('../../agent/core/channelModel');
const toolRegistry = require('../../tools/toolRegistry');
const toolPermissions = require('../../agent/core/toolPermissions');
const adapterRegistry = require('../../integrations/adapters/adapterRegistry');
const { describePlatformSupport } = require('../../integrations/adapters/platformSupportRegistry');
const { validateEnabledPlatforms } = require('../../tools/configValidator');
const { validateTask, createScheduledJob } = require('../../scheduler/scheduleModel');
const scheduleStore = require('../../scheduler/scheduleStore');
const { createBusinessSchedule, setBusinessScheduleEnabled } = require('../../scheduler/scheduleManagement');
const { resolveBusinessPolicy, AUTONOMY_KILL_SWITCH_ENV } = require('../../agent/core/autonomyPolicy');
const { evaluateCompliance } = require('../../compliance/complianceEngine');
const { CORRECTION_TOOL_IDS } = require('../../integrations/approvedCorrectionDispatch');
const { listSnapshots, getLatestSnapshot } = require('../../monitoring/snapshotStore');
const { verifyExecution } = require('../../reliability/executionVerification');
const { triggerAutonomousCycle } = require('../../autonomy/cycleTrigger');
const { isObservationJob } = require('../../autonomy/autonomousCycle');
const runHistoryStore = require('../../agent/core/runHistoryStore');
const shopifyClient = require('../../integrations/adapters/shopifyClient');
const etsyReadAdapter = require('../../integrations/adapters/etsyReadAdapter');
const aiProviderSelector = require('../../agent/core/aiProviderSelector');

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

global.fetch = () => {
  throw new Error('This suite must never make a network call.');
};

// External boundaries only: count every real-platform read so "never touched" is evidence.
const platformReads = [];
for (const capability of ['getShopInfo', 'getProducts', 'getCollections', 'getInventoryLevels', 'getOrders', 'getCustomers']) {
  shopifyClient[capability] = async ({ businessId } = {}) => {
    platformReads.push({ platform: 'shopify', businessId, capability });
    return capability === 'getShopInfo' ? { name: 'x', domain: 'x', email: null } : [];
  };
}
shopifyClient.isConfigured = () => true;
etsyReadAdapter.isConfigured = () => true;
etsyReadAdapter.getShopInfo = async ({ businessId } = {}) => {
  platformReads.push({ platform: 'etsy', businessId, capability: 'getShopInfo' });
  return { name: 'x', domain: null, email: null };
};
etsyReadAdapter.getProducts = async ({ businessId } = {}) => {
  platformReads.push({ platform: 'etsy', businessId, capability: 'getProducts' });
  return [];
};
let aiCalls = 0;
aiProviderSelector.sendMessage = async () => {
  aiCalls += 1;
  return { text: 'Review the synthetic listing change.', model: 'stub-model', stopReason: 'end_turn', usage: { input_tokens: 5, output_tokens: 7 } };
};

const ON = { [AUTONOMY_KILL_SWITCH_ENV]: 'true' };
const at = (hour) => new Date(`2026-03-04T${String(hour).padStart(2, '0')}:07:00.000Z`);
const stepOf = (cycle, jobId) => cycle.steps.find((step) => step.job_id === jobId) || {};

async function withKillSwitchOn(fn) {
  const saved = process.env[AUTONOMY_KILL_SWITCH_ENV];
  process.env[AUTONOMY_KILL_SWITCH_ENV] = 'true';
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env[AUTONOMY_KILL_SWITCH_ENV];
    else process.env[AUTONOMY_KILL_SWITCH_ENV] = saved;
  }
}

// ---------------------------------------------------------------------------------
// A. No platform literal in core autonomy runtime code
// ---------------------------------------------------------------------------------

const CORE_AUTONOMY_FILES = [
  'autonomy/autonomousCycle.js',
  'autonomy/approvalResolution.js',
  'autonomy/cycleTrigger.js',
  'autonomy/runCycleCli.js',
  'scheduler/scheduleModel.js',
  'scheduler/scheduleRunner.js',
  'scheduler/scheduleStore.js',
  'scheduler/scheduleManagement.js',
  'monitoring/platformMonitor.js',
  'monitoring/changeDetection.js',
  'monitoring/snapshotModel.js',
  'monitoring/snapshotStore.js',
  'reliability/circuitBreaker.js',
  'reliability/executionVerification.js',
  'agent/core/autonomyPolicy.js',
  'agent/core/dailyUsageAccounting.js',
  'approvals/approvalStore.js',
  'approvals/approvalWorkflow.js',
];

test('A core autonomy runtime code names no platform and no platform-bound tool', () => {
  for (const file of CORE_AUTONOMY_FILES) {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
    const runtime = source.split('if (require.main === module)')[0];
    const code = runtime
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    assert.ok(!/['"`](shopify|etsy|amazon|ebay)['"`]/i.test(code), `${file} names a platform in runtime code`);
    assert.ok(!/\b(shopify|etsy)_[a-z_]+/i.test(code), `${file} names a platform-bound tool in runtime code`);
  }
});

// ---------------------------------------------------------------------------------
// B. Observation declarations live at the registration point and are truthful
// ---------------------------------------------------------------------------------

test('B every declared observation tool is a real, implemented read tool bound to exactly its platform', () => {
  const seen = new Set();
  for (const platform of adapterRegistry.REGISTERED_READ_PLATFORMS) {
    const ids = adapterRegistry.getObservationToolIds(platform);
    assert.ok(ids.length > 0, `${platform} declares no observation tool`);
    for (const id of ids) {
      const tool = toolRegistry.getToolById(id);
      assert.ok(tool, `${id} is not in the tool registry`);
      assert.strictEqual(tool.status, 'implemented');
      assert.strictEqual(tool.operation, 'read', `${id} must be a read`);
      assert.deepStrictEqual(tool.platforms, [platform], `${id} must be bound to exactly '${platform}'`);
      assert.ok(!seen.has(id), `${id} is declared for two platforms`);
      seen.add(id);
    }
  }
});

test('B a platform with no read adapter has no observation tool, even if one were declared', () => {
  for (const platform of ['amazon', 'ebay', SYNTHETIC]) {
    assert.deepStrictEqual(adapterRegistry.getObservationToolIds(platform), []);
  }
  adapterRegistry.OBSERVATION_TOOLS.amazon = ['product_data_retrieval'];
  try {
    assert.deepStrictEqual(adapterRegistry.getObservationToolIds('amazon'), [], 'a declaration never substitutes for an adapter');
    assert.strictEqual(isObservationJob('product_data_retrieval', 'amazon'), false);
  } finally {
    delete adapterRegistry.OBSERVATION_TOOLS.amazon;
  }
});

// ---------------------------------------------------------------------------------
// C. The real truth, per platform, at every layer (nothing modified)
// ---------------------------------------------------------------------------------

const toolsBoundTo = (platform) => toolRegistry.TOOL_REGISTRY.filter((tool) => Array.isArray(tool.platforms) && tool.platforms.includes(platform));

test('C Shopify: integrated read surface, observable, and the only platform with (approval-gated) write tools', () => {
  const support = describePlatformSupport('shopify');
  assert.strictEqual(support.support_level, 'integrated');
  assert.deepStrictEqual(support.read_capabilities_unsupported, []);
  assert.strictEqual(support.publishing_available, true);
  assert.strictEqual(support.compliance_can_pass, false);
  assert.strictEqual(support.production_ready, false);
  assert.strictEqual(validateEnabledPlatforms({ enabled_platforms: ['shopify'] }).valid, true);
  const writes = toolsBoundTo('shopify').filter((tool) => tool.operation !== 'read').map((tool) => tool.id).sort();
  assert.deepStrictEqual(writes, CORRECTION_TOOL_IDS.slice().sort());
  for (const id of writes) {
    assert.strictEqual(toolPermissions.TOOL_CLASSIFICATIONS[id], 'externally_executable', `${id} must always need approval`);
    assert.notStrictEqual(toolPermissions.checkToolAccess({ specialistId: 'product', toolId: id, enabledPlatforms: ['etsy'] }).decision, 'allowed', `${id} must be refused where Shopify is not enabled`);
  }
});

test('C Etsy: read-only - unsupported reads are declared, no write tool exists, no publishing path is reachable', () => {
  const support = describePlatformSupport('etsy');
  assert.strictEqual(support.support_level, 'integrated');
  assert.deepStrictEqual(support.read_capabilities_unsupported.slice().sort(), ['getCollections', 'getCustomers', 'getInventoryLevels', 'getOrders']);
  assert.strictEqual(support.publishing_available, false);
  assert.strictEqual(support.compliance_can_pass, false);
  assert.deepStrictEqual(toolsBoundTo('etsy').filter((tool) => tool.operation !== 'read'), [], 'no Etsy write tool may exist');
  for (const id of CORRECTION_TOOL_IDS) {
    assert.ok(!toolRegistry.getToolById(id).platforms.includes('etsy'), `${id} must not target Etsy`);
  }
});

for (const platform of ['amazon', 'ebay']) {
  test(`C ${platform}: architecture refuses it at every layer - no adapter, not enableable, not schedulable, no tool, never observable, compliance never PASS`, () => {
    const support = describePlatformSupport(platform);
    assert.strictEqual(support.support_level, 'context_only');
    for (const flag of ['may_be_enabled', 'read_adapter_registered', 'can_be_monitored', 'can_be_verified', 'publishing_available', 'compliance_can_pass', 'production_ready']) {
      assert.strictEqual(support[flag], false, `${platform}.${flag}`);
    }
    assert.strictEqual(validateEnabledPlatforms({ enabled_platforms: [platform] }).valid, false);
    assert.strictEqual(validateTask({ tool_id: 'listing_quality_check', objective: 'x', platform }).valid, false);
    assert.throws(() => adapterRegistry.getReadAdapter(platform));
    assert.deepStrictEqual(toolsBoundTo(platform), []);
    assert.deepStrictEqual(adapterRegistry.getObservationToolIds(platform), []);
    const verdict = evaluateCompliance({
      content: 'A handmade ceramic mug.',
      content_type: 'product_listing',
      platform_context: { platform },
      required_checks: ['platform_policy'],
      provenance: { source: 'scheduled_job', generator: 'agent' },
    });
    assert.notStrictEqual(verdict.status, 'PASS', `${platform} content must never PASS without real structured rules`);
  });
}

// ---------------------------------------------------------------------------------
// D and E
// ---------------------------------------------------------------------------------

(async () => {
  await withKillSwitchOn(async () => {
    await testAsync('D an observation tool never observes a platform it is not declared for', async () => {
      assert.strictEqual(isObservationJob('etsy_listing_data_retrieval', 'etsy'), true);
      assert.strictEqual(isObservationJob('etsy_listing_data_retrieval', 'shopify'), false);
      // Management accepts this (both platforms are enabled for the business); the cycle is the gate.
      scheduleStore.saveScheduledJob(createScheduledJob({ jobId: 'mismatch', businessId: MIXED_BUSINESS, enabled: true, schedule: { kind: 'interval_minutes', every: 60 }, task: { tool_id: 'etsy_listing_data_retrieval', objective: 'Observe.', platform: 'shopify' }, now: at(9) }));
      const cycle = await triggerAutonomousCycle({ businessId: MIXED_BUSINESS, now: at(9), env: ON });
      assert.strictEqual(cycle.triggered, true, cycle.reason);
      assert.strictEqual(stepOf(cycle, 'mismatch').outcome, 'blocked');
      assert.strictEqual(stepOf(cycle, 'mismatch').reason_code, 'observation_platform_mismatch');
      assert.ok(!platformReads.some((read) => read.businessId === MIXED_BUSINESS), 'nothing was read from either platform');
    });

    // --- E. Onboarding a synthetic platform through the registration points only ---
    const listing = { stock: 4 };
    const syntheticAdapter = {
      // Declared like Etsy: what this fixture cannot serve is refused, never faked as zero.
      UNSUPPORTED_READ_CAPABILITIES: ['getOrders', 'getCustomers', 'getInventoryLevels', 'getCollections'],
      isConfigured: () => true,
      getShopInfo: async () => ({ name: 'Synthetic fixture shop', domain: null, email: null }),
      getProducts: async () => {
        platformReads.push({ platform: SYNTHETIC, capability: 'getProducts' });
        return [{ id: 'synthetic-listing-1', title: 'Fixture Lamp', status: 'active', tags: [], variants: [{ available: listing.stock > 0, inventory_quantity: listing.stock }] }];
      },
      getOrders: async () => { throw new Error('unsupported'); },
      getCustomers: async () => { throw new Error('unsupported'); },
      getInventoryLevels: async () => { throw new Error('unsupported'); },
      getCollections: async () => { throw new Error('unsupported'); },
    };
    const syntheticTool = {
      id: SYNTHETIC_TOOL,
      title: 'Synthetic test marketplace listing observation (test fixture only)',
      description: 'Test-only fixture tool proving a platform onboards through registration points alone.',
      category: 'products',
      operation: 'read',
      status: 'implemented',
      platforms: [SYNTHETIC],
    };
    const onboarded = { channel: false, tool: false, adapter: false, observation: false };
    const syntheticReads = () => platformReads.filter((read) => read.platform === SYNTHETIC).length;

    try {
      await testAsync('E0 before onboarding: the business config is refused and nothing can be scheduled', async () => {
        assert.strictEqual(resolveBusinessPolicy(SYNTH_BUSINESS).ok, false);
        const refused = createBusinessSchedule({ businessId: SYNTH_BUSINESS, jobId: 'observe', schedule: { kind: 'interval_minutes', every: 60 }, task: { tool_id: 'listing_quality_check', objective: 'x', platform: SYNTHETIC }, now: at(9) });
        assert.strictEqual(refused.ok, false);
      });

      // Registration steps 1-2: channel vocabulary, tool registry + approval classification.
      channelModel.CHANNELS.push(SYNTHETIC);
      onboarded.channel = true;
      toolRegistry.TOOL_REGISTRY.push(syntheticTool);
      toolPermissions.TOOL_CLASSIFICATIONS[SYNTHETIC_TOOL] = 'analysis_only';
      onboarded.tool = true;

      await testAsync('E1 channel + tool, no adapter: schedulable, but the cycle never observes or dispatches it', async () => {
        assert.strictEqual(resolveBusinessPolicy(SYNTH_BUSINESS).ok, true);
        const created = createBusinessSchedule({
          businessId: SYNTH_BUSINESS,
          jobId: 'observe',
          schedule: { kind: 'interval_minutes', every: 60 },
          task: { tool_id: SYNTHETIC_TOOL, objective: 'Observe the synthetic listings.', platform: SYNTHETIC, follow_ups: [{ tool_id: 'ai_reasoning_completion', objective: 'Recommend what to review about this listing change.' }] },
          now: at(9),
        });
        assert.strictEqual(created.ok, true, `${created.reason} ${JSON.stringify(created.errors || [])}`);
        assert.strictEqual(setBusinessScheduleEnabled({ businessId: SYNTH_BUSINESS, jobId: 'observe', enabled: true, now: at(9) }).ok, true);

        const shopifyBound = createBusinessSchedule({ businessId: SYNTH_BUSINESS, jobId: 'shopify-follow-up', schedule: { kind: 'interval_minutes', every: 60 }, task: { tool_id: SYNTHETIC_TOOL, objective: 'Observe.', platform: SYNTHETIC, follow_ups: [{ tool_id: 'business_configuration_retrieval', objective: 'Retrieve config.' }] }, now: at(9) });
        assert.strictEqual(shopifyBound.reason_code, 'platform_not_enabled', 'a Shopify-bound capability is never assumed on another platform');

        const cycle = await triggerAutonomousCycle({ businessId: SYNTH_BUSINESS, now: at(9), env: ON });
        assert.strictEqual(stepOf(cycle, 'observe').outcome, 'blocked');
        assert.strictEqual(stepOf(cycle, 'observe').reason_code, 'capability_not_owned');
        assert.strictEqual(syntheticReads(), 0);
      });

      // Registration step 3: the read adapter.
      adapterRegistry.READ_ADAPTERS[SYNTHETIC] = syntheticAdapter;
      onboarded.adapter = true;

      await testAsync('E2 + adapter, no observation declaration: resolvable and verifiable, but still never observed by the cycle', async () => {
        assert.strictEqual(adapterRegistry.getReadAdapter(SYNTHETIC), syntheticAdapter);
        const verification = await verifyExecution({ businessId: SYNTH_BUSINESS, platform: SYNTHETIC, action: 'fixture', entityKind: 'product', entityId: 'synthetic-listing-1', expected: { title: 'Fixture Lamp' }, enabledPlatforms: [SYNTHETIC], persist: false });
        assert.strictEqual(verification.status, 'verified', 'verification resolves any registered platform through the registry');
        const readsBefore = syntheticReads();
        const cycle = await triggerAutonomousCycle({ businessId: SYNTH_BUSINESS, now: at(10), env: ON });
        assert.strictEqual(stepOf(cycle, 'observe').reason_code, 'capability_not_owned');
        assert.strictEqual(syntheticReads(), readsBefore, 'the cycle did not read it');
      });

      // Registration step 4: the observation declaration, beside the adapter.
      adapterRegistry.OBSERVATION_TOOLS[SYNTHETIC] = [SYNTHETIC_TOOL];
      onboarded.observation = true;

      await testAsync('E3 fully onboarded: observed, snapshotted per platform, unsupported reads recorded honestly - no core edit', async () => {
        const cycle = await triggerAutonomousCycle({ businessId: SYNTH_BUSINESS, now: at(11), env: ON });
        assert.strictEqual(stepOf(cycle, 'observe').outcome, 'observed', JSON.stringify(stepOf(cycle, 'observe')));
        assert.strictEqual(listSnapshots({ businessId: SYNTH_BUSINESS, platform: SYNTHETIC }).length, 1);
        assert.strictEqual(listSnapshots({ businessId: SYNTH_BUSINESS, platform: 'shopify' }).length, 0);
        assert.ok(JSON.stringify(getLatestSnapshot({ businessId: SYNTH_BUSINESS, platform: SYNTHETIC })).includes('"unsupported"'));
      });

      await testAsync('E4 a change on the new platform runs the follow-up through the Chief, with no Shopify or Etsy touched', async () => {
        listing.stock = 0;
        const cycle = await triggerAutonomousCycle({ businessId: SYNTH_BUSINESS, now: at(12), env: ON });
        assert.strictEqual(stepOf(cycle, 'observe').outcome, 'observed');
        assert.strictEqual(stepOf(cycle, 'observe--follow-up-1').outcome, 'executed', JSON.stringify(stepOf(cycle, 'observe--follow-up-1')));
        assert.strictEqual(aiCalls, 1);
        const record = runHistoryStore.getRunRecordById(cycle.cycle_id);
        assert.ok(record.result.audit_trail.some((event) => event.summary === "Invoking tool 'ai_reasoning_completion'."));
        assert.ok(!platformReads.some((read) => read.businessId === SYNTH_BUSINESS && read.platform !== SYNTHETIC), 'no other platform was read for this business');
      });

      await testAsync('E5 the new platform still has no write path: a Shopify correction is refused by the policy, not queued', async () => {
        scheduleStore.saveScheduledJob(createScheduledJob({ jobId: 'tampered-write', businessId: SYNTH_BUSINESS, enabled: true, schedule: { kind: 'interval_minutes', every: 60 }, task: { tool_id: 'shopify_vendor_correction', objective: 'Correct the vendor on the product.', platform: SYNTHETIC, params: { content: 'Vendor', productId: 'synthetic-listing-1', newVendor: 'Vendor' } }, now: at(13) }));
        const cycle = await triggerAutonomousCycle({ businessId: SYNTH_BUSINESS, now: at(13), env: ON });
        assert.strictEqual(stepOf(cycle, 'tampered-write').outcome, 'blocked');
        assert.strictEqual(stepOf(cycle, 'tampered-write').reason_code, 'unauthorized_platform');
        assert.strictEqual(stepOf(cycle, 'tampered-write').approval_request_id, null);
      });
    } finally {
      if (onboarded.observation) delete adapterRegistry.OBSERVATION_TOOLS[SYNTHETIC];
      if (onboarded.adapter) delete adapterRegistry.READ_ADAPTERS[SYNTHETIC];
      if (onboarded.tool) {
        delete toolPermissions.TOOL_CLASSIFICATIONS[SYNTHETIC_TOOL];
        toolRegistry.TOOL_REGISTRY.splice(toolRegistry.TOOL_REGISTRY.indexOf(syntheticTool), 1);
      }
      if (onboarded.channel) channelModel.CHANNELS.splice(channelModel.CHANNELS.indexOf(SYNTHETIC), 1);
    }

    await testAsync('E6 after removal the synthetic platform is gone from every registration point', async () => {
      assert.strictEqual(channelModel.isValidChannel(SYNTHETIC), false);
      assert.strictEqual(adapterRegistry.hasReadAdapter(SYNTHETIC), false);
      assert.strictEqual(toolRegistry.getToolById(SYNTHETIC_TOOL), undefined);
      assert.deepStrictEqual(adapterRegistry.getObservationToolIds(SYNTHETIC), []);
      assert.deepStrictEqual(channelModel.CHANNELS, ['shopify', 'etsy']);
    });
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('platformGenerality.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
