'use strict';

// PRODUCTION-READINESS ACCURACY GUARD.
//
// This suite exists because of a real defect found in this codebase: three tools were
// registered `status: 'implemented'`, their descriptions pointed at three wrapper files
// that had never been written, and none of them had a TOOL_EXECUTORS entry - so the
// registry claimed an executable capability that dispatch could not reach. A registry that
// can drift from reality is worse than no registry, because everything downstream trusts it.
//
// Every test here checks a CLAIM against the thing that would have to be true for it.
// Nothing here is a style check.
//
// NO EXTERNAL API IS CALLED, and none could be: this suite only reads source files and
// already-loaded module exports. global.fetch is replaced for the whole file with a
// function that FAILS the suite if anything reaches for the network.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { TOOL_REGISTRY, getToolById } = require('../../tools/toolRegistry');
const { TOOL_CLASSIFICATIONS, checkToolAccess, CATEGORY_TO_SPECIALIST } = require('../../agent/core/toolPermissions');
const { describeAllPlatformSupport, describePlatformSupport } = require('../../integrations/adapters/platformSupportRegistry');
const { CHANNELS } = require('../../agent/core/channelModel');

const REPO_ROOT = path.join(__dirname, '..', '..');

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

global.fetch = () => {
  throw new Error('This suite must never make a network call.');
};

// Every repo-relative source path a piece of text mentions.
function referencedPaths(text) {
  if (typeof text !== 'string') return [];
  const matches = text.match(/\b(?:tools|agent\/core|integrations(?:\/adapters)?|approvals|compliance|monitoring|scheduler|reliability|autonomy|usage|audit|security|configuration|verification\/testing)\/[A-Za-z0-9_./-]+\.js\b/g);
  return Array.from(new Set(matches || []));
}

// The tool ids agent/core/orchestratorExecutionContract.js actually wires an executor for,
// read from its source. Read rather than exported, because TOOL_EXECUTORS is deliberately
// private to that module - this suite must observe reality, not be handed a summary of it.
function wiredExecutorIds() {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'agent', 'core', 'orchestratorExecutionContract.js'), 'utf8');
  const block = source.slice(source.indexOf('const TOOL_EXECUTORS'), source.indexOf('\n};', source.indexOf('const TOOL_EXECUTORS')));
  const ids = new Set();
  for (const tool of TOOL_REGISTRY) {
    if (new RegExp(`(^|\\n)\\s*${tool.id}\\s*:`).test(block)) ids.add(tool.id);
  }
  // The three approved corrections are dispatched by a SEPARATE, deliberately narrower
  // path: they have no TOOL_EXECUTORS entry precisely so that ordinary dispatch cannot
  // run a consequential mutation, and are reached only by resumeApprovedExecution() via
  // integrations/approvedCorrectionDispatch.js. Counted as reachable here because they
  // genuinely are - which is the claim the registry now makes.
  for (const id of require('../../integrations/approvedCorrectionDispatch').CORRECTION_TOOL_IDS) ids.add(id);
  return ids;
}

// ---------------------------------------------------------------------------------
// Claims about files
// ---------------------------------------------------------------------------------

test('every source file a tool description points at actually exists', () => {
  const missing = [];
  for (const tool of TOOL_REGISTRY) {
    for (const reference of referencedPaths(tool.description)) {
      if (!fs.existsSync(path.join(REPO_ROOT, reference))) missing.push(`${tool.id} -> ${reference}`);
    }
  }
  assert.deepStrictEqual(missing, [], `tool descriptions name files that do not exist:\n  ${missing.join('\n  ')}`);
});

test('every source file the tool registry header points at actually exists', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'tools', 'toolRegistry.js'), 'utf8');
  const header = source.slice(0, source.indexOf('const TOOL_PLATFORMS'));
  const missing = referencedPaths(header).filter((reference) => !fs.existsSync(path.join(REPO_ROOT, reference)));
  assert.deepStrictEqual(missing, [], `the registry header names files that do not exist:\n  ${missing.join('\n  ')}`);
});

// ---------------------------------------------------------------------------------
// Claims about executability
// ---------------------------------------------------------------------------------

test('an implemented tool with no executor says so in its own description', () => {
  const wired = wiredExecutorIds();
  const unexplained = [];
  for (const tool of TOOL_REGISTRY) {
    if (tool.status !== 'implemented') continue;
    if (wired.has(tool.id)) continue;
    // The registry may only carry an implemented-but-undispatchable entry when the entry
    // ITSELF states that plainly. Silence here is the defect this suite exists to catch.
    if (!/NOT REACHABLE THROUGH CHIEF DISPATCH/.test(tool.description)) unexplained.push(tool.id);
  }
  assert.deepStrictEqual(
    unexplained,
    [],
    `these tools claim status 'implemented' but have no executor and do not say so:\n  ${unexplained.join('\n  ')}`
  );
});

test('every implemented tool is now genuinely reachable', () => {
  const wired = wiredExecutorIds();
  const undispatchable = TOOL_REGISTRY.filter((tool) => tool.status === 'implemented' && !wired.has(tool.id)).map((tool) => tool.id).sort();
  assert.deepStrictEqual(undispatchable, [], `these tools claim to be implemented but nothing can run them:\n  ${undispatchable.join('\n  ')}`);
});

test('the three corrections are reachable ONLY through an approved execution', () => {
  const { CORRECTION_TOOL_IDS } = require('../../integrations/approvedCorrectionDispatch');
  assert.deepStrictEqual(CORRECTION_TOOL_IDS.slice().sort(), [
    'shopify_collection_membership_update',
    'shopify_inventory_correction',
    'shopify_vendor_correction',
  ]);

  const source = fs.readFileSync(path.join(REPO_ROOT, 'agent', 'core', 'orchestratorExecutionContract.js'), 'utf8');
  const executorBlock = source.slice(source.indexOf('const TOOL_EXECUTORS'), source.indexOf('\n};', source.indexOf('const TOOL_EXECUTORS')));
  for (const id of CORRECTION_TOOL_IDS) {
    // No ordinary executor: unapproved dispatch must not be able to reach a mutation.
    assert.ok(!new RegExp(`(^|\\n)\\s*${id}\\s*:`).test(executorBlock), `${id} must NOT have a TOOL_EXECUTORS entry`);
    const tool = getToolById(id);
    assert.ok(/REACHABLE ONLY THROUGH AN APPROVED EXECUTION/.test(tool.description), `${id} must state how it is reached`);
    const references = referencedPaths(tool.description).filter((reference) => reference.startsWith('integrations/'));
    assert.ok(references.length > 0, `${id} must name where its capability lives`);
    for (const reference of references) {
      assert.ok(fs.existsSync(path.join(REPO_ROOT, reference)), `${id} names a missing module: ${reference}`);
    }
  }

  // The dispatch is invoked from the approved path and nowhere else.
  const resume = source.slice(source.indexOf('async function resumeApprovedExecution'));
  assert.ok(resume.includes('executeApprovedCorrection'), 'the approved path must dispatch corrections');
  const beforeResume = source.slice(0, source.indexOf('async function resumeApprovedExecution'));
  assert.ok(!beforeResume.includes('executeApprovedCorrection('), 'nothing before the approved path may dispatch a correction');
});

test('every tool with an executor is registered implemented', () => {
  const wired = wiredExecutorIds();
  for (const id of wired) {
    const tool = getToolById(id);
    assert.ok(tool, `an executor is wired for unknown tool '${id}'`);
    assert.strictEqual(tool.status, 'implemented', `'${id}' has an executor but is registered '${tool.status}'`);
  }
  assert.ok(wired.size >= 20, `expected many wired executors, found ${wired.size}`);
});

test('a not_implemented tool is genuinely unreachable through the permission gate', () => {
  for (const tool of TOOL_REGISTRY) {
    if (tool.status === 'implemented') continue;
    const access = checkToolAccess({
      specialistId: CATEGORY_TO_SPECIALIST[tool.category] || null,
      toolId: tool.id,
      enabledPlatforms: CHANNELS.slice(),
    });
    assert.strictEqual(access.decision, 'unavailable', `'${tool.id}' is '${tool.status}' but the gate says '${access.decision}'`);
  }
});

// ---------------------------------------------------------------------------------
// Claims about platforms
// ---------------------------------------------------------------------------------

test('no tool is bound to a platform this project has no adapter for', () => {
  const integrated = describeAllPlatformSupport().filter((entry) => entry.support_level === 'integrated').map((entry) => entry.platform);
  for (const tool of TOOL_REGISTRY) {
    for (const platform of tool.platforms) {
      assert.ok(integrated.includes(platform), `tool '${tool.id}' is bound to '${platform}', which is not integrated`);
    }
  }
});

test('nothing in the project claims Amazon or eBay support', () => {
  for (const platform of ['amazon', 'ebay']) {
    const entry = describePlatformSupport(platform);
    assert.strictEqual(entry.support_level, 'context_only');
    assert.strictEqual(entry.may_be_enabled, false);
    assert.strictEqual(entry.publishing_available, false);
    assert.strictEqual(entry.production_ready, false);
  }
});

test('no platform is described as production-ready anywhere in the support registry', () => {
  for (const entry of describeAllPlatformSupport()) {
    assert.strictEqual(entry.production_ready, false, `${entry.platform} claims production readiness`);
  }
});

// ---------------------------------------------------------------------------------
// Claims about configuration
// ---------------------------------------------------------------------------------

test('every environment variable the code reads is documented in .env.example', () => {
  const envExample = fs.readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8');

  // The directories whose modules are part of this system's own configuration surface.
  const searchDirs = ['agent/core', 'approvals', 'monitoring', 'scheduler', 'reliability', 'autonomy', 'security', 'configuration', 'tools', 'usage', 'audit', 'compliance', 'integrations', 'integrations/adapters'];
  const referenced = new Set();
  for (const dir of searchDirs) {
    const full = path.join(REPO_ROOT, dir);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full)) {
      if (!name.endsWith('.js')) continue;
      const source = fs.readFileSync(path.join(full, name), 'utf8');
      // Code only - a comment quoting a variable name is documentation, not a read.
      const code = source.split('\n').filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*')).join('\n');
      for (const match of code.match(/process\.env\.([A-Z][A-Z0-9_]*)/g) || []) {
        referenced.add(match.replace('process.env.', ''));
      }
      for (const match of code.match(/process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g) || []) {
        referenced.add(match.replace(/process\.env\[['"]/, '').replace(/['"]\]/, ''));
      }
    }
  }

  // NODE_ENV and PORT are runtime/hosting concerns, not this project's own configuration.
  const exempt = new Set(['NODE_ENV', 'PORT']);
  const undocumented = Array.from(referenced)
    .filter((name) => !exempt.has(name))
    .filter((name) => !new RegExp(`^\\s*#?\\s*${name}=`, 'm').test(envExample) && !envExample.includes(name))
    .sort();

  assert.deepStrictEqual(undocumented, [], `these environment variables are read but undocumented in .env.example:\n  ${undocumented.join('\n  ')}`);
});

test('.env.example contains no real or example secret value', () => {
  const envExample = fs.readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8');
  // Every assignment must be empty - a template carries names, never values.
  const assignments = envExample.split('\n').filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line));
  assert.ok(assignments.length > 10, 'the template should document many variables');
  for (const line of assignments) {
    assert.ok(/^[A-Z][A-Z0-9_]*=\s*$/.test(line), `.env.example assigns a value: ${line}`);
  }
  // And no key material of any kind, not even a dummy one.
  for (const marker of ['BEGIN PRIVATE KEY', 'BEGIN RSA', 'BEGIN OPENSSH', 'BEGIN EC PRIVATE', 'shpat_', 'sk-ant-']) {
    assert.ok(!envExample.includes(marker), `.env.example must not contain '${marker}'`);
  }
});

test('the platform gate has a real live caller in the execution path', () => {
  // The defect this replaces: the gate existed but nothing supplied enabledPlatforms, so it
  // was inert in production. Both dispatch paths must now engage it.
  const source = fs.readFileSync(path.join(REPO_ROOT, 'agent', 'core', 'orchestratorExecutionContract.js'), 'utf8');
  const code = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  const callSites = code.match(/checkToolAccess\(\{[\s\S]{0,400}?\}\)/g) || [];
  assert.ok(callSites.length >= 2, `expected both dispatch paths to check tool access, found ${callSites.length}`);
  for (const site of callSites) {
    assert.ok(site.includes('enabledPlatforms'), `a checkToolAccess call in the execution path does not engage the platform gate:\n${site}`);
  }
  // And the resolver fails closed for a business whose configuration cannot be read.
  const { resolveEnabledPlatformsForBusiness } = require('../../agent/core/orchestratorExecutionContract');
  assert.deepStrictEqual(resolveEnabledPlatformsForBusiness('no-such-business-anywhere'), []);
});

test('this test file is registered in the suite runner', () => {
  const { TEST_FILES } = require('./runAllTests');
  assert.ok(TEST_FILES.includes('registryAccuracy.test.js'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
