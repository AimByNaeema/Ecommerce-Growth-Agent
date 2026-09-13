'use strict';

// The Amazon/eBay boundary: integrations/adapters/platformSupportRegistry.js, and proof
// that an unsupported platform is refused at EVERY layer of this architecture rather than
// at one of them.
//
// THIS SUITE EXISTS TO STOP A FALSE CAPABILITY CLAIM. 'amazon' and 'ebay' appear in this
// project's source for exactly one reason: compliance will accept them as a stated CONTEXT
// so content intended for them can be checked against this project's own rules. Every test
// below pins the consequence of that - context is not integration, and it grants nothing.
//
// NO EXTERNAL API IS CALLED ANYWHERE HERE, and none could be: there is no adapter for
// either platform to call. global.fetch is replaced for the whole file with a function that
// FAILS the suite if anything reaches for the network.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const platformSupport = require('../../integrations/adapters/platformSupportRegistry');
const {
  SUPPORT_LEVELS,
  ONBOARDING_REQUIREMENTS,
  knownPlatformNames,
  describePlatformSupport,
  describeAllPlatformSupport,
  listUnsupportedPlatforms,
  isPlatformIntegrated,
} = platformSupport;

const { getReadAdapter, hasReadAdapter, REGISTERED_READ_PLATFORMS } = require('../../integrations/adapters/adapterRegistry');
const { CHANNELS, isValidChannel } = require('../../agent/core/channelModel');
const { validateEnabledPlatforms, readEnabledPlatforms } = require('../../tools/configValidator');
const { isPlatformEnabledForBusiness, checkToolAccess } = require('../../agent/core/toolPermissions');
const { evaluateAutonomyPolicy, AUTONOMY_KILL_SWITCH_ENV } = require('../../agent/core/autonomyPolicy');
const { observePlatform } = require('../../monitoring/platformMonitor');
const { planVerification, verifyExecution } = require('../../reliability/executionVerification');
const { createScheduledJob } = require('../../scheduler/scheduleModel');
const { evaluateCompliance } = require('../../compliance/complianceEngine');
const { RECOGNIZED_PLATFORMS } = require('../../compliance/compliancePolicy');

const UNSUPPORTED = ['amazon', 'ebay'];

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

function withTempRoot(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-boundary-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempRootAsync(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-boundary-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------
// The registry itself
// ---------------------------------------------------------------------------------

test('the support registry is derived from the real sources, never hand-asserted', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'integrations', 'adapters', 'platformSupportRegistry.js'), 'utf8');
  const code = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  // It reads the three real sources.
  assert.ok(code.includes("require('../../agent/core/channelModel')"));
  assert.ok(code.includes("require('./adapterRegistry')"));
  assert.ok(code.includes("require('../../compliance/compliancePolicy')"));
  // And it contains no hardcoded supported-platform list of its own.
  assert.ok(!/SUPPORTED_PLATFORMS\s*=/.test(code));
  // Naming a platform here cannot make it work: the known list comes from the sources.
  assert.deepStrictEqual(knownPlatformNames().sort(), Array.from(new Set([...CHANNELS, ...REGISTERED_READ_PLATFORMS, ...RECOGNIZED_PLATFORMS])).sort());
});

test('every known platform is described with one of the declared support levels', () => {
  const all = describeAllPlatformSupport();
  assert.ok(all.length >= 4);
  for (const entry of all) {
    assert.ok(SUPPORT_LEVELS.includes(entry.support_level), `${entry.platform}: ${entry.support_level}`);
  }
  // The integrated set is exactly the registered read adapters - nothing more.
  assert.deepStrictEqual(all.filter((entry) => entry.support_level === 'integrated').map((entry) => entry.platform).sort(), REGISTERED_READ_PLATFORMS.slice().sort());
});

test('no platform is claimed production-ready, and none can pass a platform-policy check', () => {
  for (const entry of describeAllPlatformSupport()) {
    assert.strictEqual(entry.production_ready, false, `${entry.platform} must not be claimed production-ready`);
    assert.strictEqual(entry.compliance_can_pass, false, `${entry.platform} must not be claimed able to pass compliance`);
  }
});

test('Amazon and eBay are context_only, and every capability flag on them is false', () => {
  for (const platform of UNSUPPORTED) {
    const entry = describePlatformSupport(platform);
    assert.strictEqual(entry.support_level, 'context_only');
    assert.strictEqual(entry.may_be_enabled, false);
    assert.strictEqual(entry.read_adapter_registered, false);
    assert.strictEqual(entry.can_be_monitored, false);
    assert.strictEqual(entry.can_be_verified, false);
    assert.strictEqual(entry.publishing_available, false);
    assert.deepStrictEqual(entry.read_capabilities_supported, []);
    assert.strictEqual(isPlatformIntegrated(platform), false);
    // Context recognition is the ONE thing that is true, and it grants nothing.
    assert.strictEqual(entry.compliance_context_recognized, true);
    assert.ok(listUnsupportedPlatforms().some((item) => item.platform === platform));
  }
});

test('Etsy is integrated but its unsupported read capabilities are stated, not hidden', () => {
  const etsy = describePlatformSupport('etsy');
  assert.strictEqual(etsy.support_level, 'integrated');
  assert.ok(etsy.read_capabilities_unsupported.length > 0, 'Etsy genuinely cannot serve some capabilities and must say so');
  assert.strictEqual(etsy.publishing_available, false, 'Etsy publishing is not available and must not be claimed');
  // Shopify's write paths exist and are claimed, accurately.
  assert.strictEqual(describePlatformSupport('shopify').publishing_available, true);
});

test('onboarding is documented as configuration and authorization work, not a core rewrite', () => {
  assert.ok(ONBOARDING_REQUIREMENTS.length >= 5);
  for (const requirement of ONBOARDING_REQUIREMENTS) {
    for (const field of ['id', 'title', 'description', 'blocks_without']) {
      assert.ok(typeof requirement[field] === 'string' && requirement[field].trim() !== '', `${requirement.id} missing ${field}`);
    }
  }
  const ids = ONBOARDING_REQUIREMENTS.map((entry) => entry.id);
  for (const required of ['read_adapter', 'credentials', 'explicit_enablement', 'compliance_rules', 'verification_coverage', 'publishing_path']) {
    assert.ok(ids.includes(required), `onboarding must name '${required}'`);
  }
});

// ---------------------------------------------------------------------------------
// REQUIRED: unsupported at EVERY layer
// ---------------------------------------------------------------------------------

test('layer 1 - an unsupported platform cannot be enabled in a business config', () => {
  for (const platform of UNSUPPORTED) {
    const result = validateEnabledPlatforms({ enabled_platforms: [platform] });
    assert.strictEqual(result.valid, false, `${platform} must be rejected in enabled_platforms`);
    assert.ok(result.errors[0].includes(platform));
    // And even a config that somehow contains it yields nothing enabled.
    assert.deepStrictEqual(readEnabledPlatforms({ enabled_platforms: [platform] }), []);
    assert.strictEqual(isValidChannel(platform), false);
  }
});

test('layer 2 - credentials can never enable an unsupported platform', () => {
  const saved = { AMAZON_SP_API_REFRESH_TOKEN: process.env.AMAZON_SP_API_REFRESH_TOKEN, EBAY_OAUTH_ACCESS_TOKEN: process.env.EBAY_OAUTH_ACCESS_TOKEN };
  process.env.AMAZON_SP_API_REFRESH_TOKEN = 'amzn-CANARY-DO-NOT-LEAK';
  process.env.EBAY_OAUTH_ACCESS_TOKEN = 'ebay-CANARY-DO-NOT-LEAK';
  try {
    for (const platform of UNSUPPORTED) {
      // Even with a full credential set present, the platform is not enabled and not
      // integrated. Enablement is a configuration decision and nothing else.
      assert.strictEqual(isPlatformEnabledForBusiness({ platform, enabledPlatforms: [platform] }), false);
      assert.strictEqual(isPlatformIntegrated(platform), false);
      assert.strictEqual(describePlatformSupport(platform).may_be_enabled, false);
    }
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test('layer 3 - no read adapter resolves, and no fallback is substituted', () => {
  for (const platform of UNSUPPORTED) {
    assert.strictEqual(hasReadAdapter(platform), false);
    assert.throws(() => getReadAdapter(platform), /No read adapter for platform/);
    assert.ok(!REGISTERED_READ_PLATFORMS.includes(platform));
  }
});

test('layer 4 - the autonomy policy blocks an unsupported platform', () => {
  const saved = process.env[AUTONOMY_KILL_SWITCH_ENV];
  process.env[AUTONOMY_KILL_SWITCH_ENV] = 'true';
  try {
    for (const platform of UNSUPPORTED) {
      const decision = evaluateAutonomyPolicy({
        businessId: null,
        specialistId: 'research',
        toolId: 'market_research',
        platform,
        complianceVerdict: 'PASS',
        businessPolicy: { ok: true, business_id: null, enabled_platforms: ['shopify', 'etsy'], autonomy: { enabled: true, daily_token_budget: 100000, daily_run_budget: null, approval_ttl_hours: 87600 } },
        dailyUsage: { available: true, day: '2026-03-04', tokens_total: 0, runs_counted: 0 },
      });
      assert.strictEqual(decision.decision, 'BLOCK');
      assert.strictEqual(decision.reason_code, 'unauthorized_platform');
    }
  } finally {
    if (saved === undefined) delete process.env[AUTONOMY_KILL_SWITCH_ENV];
    else process.env[AUTONOMY_KILL_SWITCH_ENV] = saved;
  }
});

test('layer 5 - no tool in the registry is bound to an unsupported platform', () => {
  const { TOOL_REGISTRY } = require('../../tools/toolRegistry');
  for (const tool of TOOL_REGISTRY) {
    for (const platform of tool.platforms) {
      assert.ok(!UNSUPPORTED.includes(platform), `tool '${tool.id}' must not be bound to '${platform}'`);
      assert.ok(isValidChannel(platform), `tool '${tool.id}' names an unrecognized platform '${platform}'`);
    }
  }
  // And a tool bound to a real platform is still denied when that platform is off.
  const denied = checkToolAccess({ specialistId: 'product', toolId: 'etsy_shop_data_retrieval', enabledPlatforms: ['shopify'] });
  assert.strictEqual(denied.platform_permitted, false);
});

test('layer 6 - an unsupported platform cannot even be scheduled', () => {
  for (const platform of UNSUPPORTED) {
    assert.throws(
      () => createScheduledJob({
        jobId: 'unsupported-job',
        businessId: 'alpha-co',
        enabled: true,
        schedule: { kind: 'interval_minutes', every: 60 },
        task: { tool_id: 'product_data_retrieval', objective: 'anything', platform },
      }),
      /platform must be a platform this project recognizes/
    );
  }
});

(async () => {
  await testAsync('layer 7 - an unsupported platform is never monitored and produces no snapshot', async () => {
    await withTempRootAsync(async (rootDir) => {
      for (const platform of UNSUPPORTED) {
        // Even a configuration that tries to enable it: the enablement predicate refuses an
        // unrecognized platform, so the adapter registry is never even consulted.
        const result = await observePlatform({ businessId: 'alpha-co', platform, enabledPlatforms: [platform], rootDir });
        assert.strictEqual(result.observed, false);
        assert.strictEqual(result.snapshot, null);
        assert.strictEqual(result.reason_code, 'platform_not_enabled');
      }
    });
  });

  await testAsync('layer 8 - an action on an unsupported platform can never be verified', async () => {
    await withTempRootAsync(async (rootDir) => {
      for (const platform of UNSUPPORTED) {
        const plan = planVerification({ businessId: 'alpha-co', platform, entityKind: 'product', enabledPlatforms: [platform] });
        assert.strictEqual(plan.verifiable, false);

        const record = await verifyExecution({
          businessId: 'alpha-co',
          platform,
          action: 'some_change',
          entityKind: 'product',
          entityId: 'x1',
          expected: { title: 'anything' },
          enabledPlatforms: [platform],
          rootDir,
        });
        assert.strictEqual(record.status, 'unverifiable');
        assert.strictEqual(record.verified, false, 'unverifiable is never a pass');
      }
    });
  });

  test('layer 9 - compliance returns REVIEW for an unsupported marketplace, never PASS', () => {
    for (const platform of UNSUPPORTED) {
      const result = evaluateCompliance({
        content: 'A plain handmade ceramic mug, thrown and glazed in our own studio.',
        content_type: 'product_listing',
        platform_context: { platform },
        required_checks: ['platform_policy'],
        provenance: { source: 'owner', generator: 'human' },
      });
      assert.notStrictEqual(result.status, 'PASS', `${platform} must never reach PASS`);
      assert.strictEqual(result.status, 'REVIEW');
      // And the reason is the honest one: no rules exist, and none were invented.
      assert.ok(
        result.findings.some((finding) => finding.rule_id === 'platform_policy_undetermined'),
        'the undetermined-policy finding must be present'
      );
    }
  });

  test('layer 10 - there is no publishing path of any kind for an unsupported platform', () => {
    for (const platform of UNSUPPORTED) {
      const entry = describePlatformSupport(platform);
      assert.strictEqual(entry.publishing_available, false);
      assert.deepStrictEqual(entry.publishing_modules, []);
    }
    // And no publishing module in the repository mentions either marketplace as a target.
    const integrationsDir = path.join(__dirname, '..', '..', 'integrations');
    for (const file of fs.readdirSync(integrationsDir).filter((name) => name.endsWith('.js'))) {
      const source = fs.readFileSync(path.join(integrationsDir, file), 'utf8');
      const code = source.split('\n').filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*')).join('\n');
      for (const platform of UNSUPPORTED) {
        assert.ok(!new RegExp(`['"\`]${platform}['"\`]`, 'i').test(code), `integrations/${file} must not target '${platform}'`);
      }
    }
  });

  test('no fake Amazon or eBay adapter file exists in the repository', () => {
    const adaptersDir = path.join(__dirname, '..', '..', 'integrations', 'adapters');
    for (const name of fs.readdirSync(adaptersDir)) {
      assert.ok(!/amazon|ebay/i.test(name), `unexpected adapter file: ${name}`);
    }
  });

  test('the registry itself declares no credentials and reads none', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'integrations', 'adapters', 'platformSupportRegistry.js'), 'utf8');
    const code = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    for (const forbidden of ['process.env', 'loadBusinessCredentials', 'fetch(']) {
      assert.ok(!code.includes(forbidden), `platformSupportRegistry.js must not contain ${forbidden}`);
    }
    // Nothing it returns could carry a secret: every value is a boolean, a name or prose.
    const serialized = JSON.stringify(describeAllPlatformSupport());
    assert.ok(!/CANARY|shpat_|sk-ant-/.test(serialized));
  });

  test('this test file is registered in the suite runner', () => {
    const { TEST_FILES } = require('./runAllTests');
    assert.ok(TEST_FILES.includes('platformSupportBoundary.test.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();
