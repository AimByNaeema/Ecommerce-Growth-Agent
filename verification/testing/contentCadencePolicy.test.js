'use strict';

// The organic daily content cadence: agent/core/contentCadencePolicy.js on its own, then
// wired through agent/core/socialAdvertisingAgent.js's content_calendar capability, the
// tools/contentCalendarTool.js wrapper, and finally the real orchestrator threading the
// target out of configuration/business.yaml. The two properties every test below exists
// to hold: the number is CONFIGURED (never defaulted, never invented), and it is
// REPORTED (never enforced - no calendar is rejected and no entry is added or removed).

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const {
  CADENCE_CONFIG_PATH,
  CADENCE_SCOPE,
  readDailyContentUnitsTarget,
  normalizeDailyContentUnits,
  checkDailyContentCadence,
  describeCadenceLimitations,
} = require('../../agent/core/contentCadencePolicy');
const { analyzeContentCalendar } = require('../../agent/core/socialAdvertisingAgent');
const { runContentCalendarTool } = require('../../tools/contentCalendarTool');
const { deriveBusinessConfigContext } = require('../../agent/core/orchestratorExecutionContract');
const { getCapabilityTask } = require('../../agent/core/specialistCapabilityRegistry');
const { loadBusinessConfig } = require('../../tools/configValidator');

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

function testAsync(name, fn) {
  return fn().then(
    () => {
      console.log(`PASS: ${name}`);
      passed += 1;
    },
    (err) => {
      console.error(`FAIL: ${name}`);
      console.error(`  ${err.message}`);
      failed += 1;
    }
  );
}

function calendarEntry(date, platform) {
  return { date, platform };
}

function cadenceLines(result) {
  return result.limitations.filter((line) => line.startsWith('Planned content volume for '));
}

// ---------------------------------------------------------------------------------
// THE TARGET IS CONFIGURED, NEVER INVENTED.
// ---------------------------------------------------------------------------------

test('NO DEFAULT EXISTS: an unconfigured business gets no target and no cadence report', () => {
  assert.strictEqual(readDailyContentUnitsTarget({}), null);
  assert.strictEqual(readDailyContentUnitsTarget({ social_content: {} }), null);
  assert.strictEqual(readDailyContentUnitsTarget({ social_content: { daily_content_units: null } }), null);
  // The template ships the key present but blank - that must read as "not configured".
  assert.strictEqual(readDailyContentUnitsTarget(YAML.parse('social_content:\n  daily_content_units:\n')), null);
  // And with no target, nothing is reported at all, however many entries exist.
  assert.strictEqual(checkDailyContentCadence([calendarEntry('2026-11-14', 'instagram')], null), null);
});

test('a non-object, missing, or wrongly-shaped config is null, never a guess', () => {
  for (const input of [null, undefined, 'two', 42, [], { social_content: 'two' }, { social_content: [] }]) {
    assert.strictEqual(readDailyContentUnitsTarget(input), null, `${JSON.stringify(input)} produced a target`);
  }
});

test('only a whole number above zero is a cadence - 0, negatives, fractions and strings are not coerced', () => {
  assert.strictEqual(normalizeDailyContentUnits(2), 2);
  assert.strictEqual(normalizeDailyContentUnits(1), 1);
  for (const bad of [0, -1, 1.5, '2', null, undefined, NaN, Infinity, true]) {
    assert.strictEqual(normalizeDailyContentUnits(bad), null, `${String(bad)} was accepted as a cadence`);
  }
});

test('the owner-confirmed target really is in configuration/business.yaml, at the documented path', () => {
  const config = loadBusinessConfig(path.join(__dirname, '..', '..', 'configuration', 'business.yaml'));
  assert.strictEqual(readDailyContentUnitsTarget(config), 2);
  assert.strictEqual(CADENCE_CONFIG_PATH, 'social_content.daily_content_units');
  // The path the module names is the path the file actually uses - no drift.
  assert.strictEqual(
    CADENCE_CONFIG_PATH.split('.').reduce((value, key) => (value == null ? undefined : value[key]), config),
    2
  );
});

test('the template documents the field without pre-filling a value, and it stays optional', () => {
  const template = loadBusinessConfig(path.join(__dirname, '..', '..', 'configuration', 'business.example.yaml'));
  assert.ok('social_content' in template, 'the template must document the field');
  assert.strictEqual(readDailyContentUnitsTarget(template), null, 'the template must not pre-fill a number');
  // A business that never sets it is still a valid business.
  const { REQUIRED_FIELDS } = require('../../tools/configValidator');
  assert.ok(!REQUIRED_FIELDS.some((field) => field.startsWith('social_content')));
});

// ---------------------------------------------------------------------------------
// COUNTING: ACROSS PLATFORMS, ORGANIC ONLY.
// ---------------------------------------------------------------------------------

test('THE RULE: 2 units on one date is on target whether they are one platform or two', () => {
  const acrossPlatforms = checkDailyContentCadence(
    [calendarEntry('2026-11-14', 'instagram'), calendarEntry('2026-11-14', 'tiktok')],
    2
  );
  const samePlatform = checkDailyContentCadence(
    [calendarEntry('2026-11-14', 'instagram'), calendarEntry('2026-11-14', 'instagram')],
    2
  );
  assert.strictEqual(acrossPlatforms.days[0].status, 'on_target');
  assert.strictEqual(samePlatform.days[0].status, 'on_target');
  // Counting is per DAY across platforms, not 2 per platform - the whole point of the rule.
  assert.strictEqual(acrossPlatforms.days[0].planned_units, 2);
  assert.deepStrictEqual(acrossPlatforms.off_target_days, []);
});

test('each date is judged on its own, and days come back in date order', () => {
  const check = checkDailyContentCadence(
    [
      calendarEntry('2026-11-16', 'tiktok'),
      calendarEntry('2026-11-14', 'instagram'),
      calendarEntry('2026-11-14', 'pinterest'),
      calendarEntry('2026-11-15', 'facebook'),
      calendarEntry('2026-11-15', 'youtube'),
      calendarEntry('2026-11-15', 'tiktok'),
    ],
    2
  );
  assert.deepStrictEqual(
    check.days.map((day) => [day.date, day.planned_units, day.status]),
    [
      ['2026-11-14', 2, 'on_target'],
      ['2026-11-15', 3, 'over_target'],
      ['2026-11-16', 1, 'under_target'],
    ]
  );
  assert.deepStrictEqual(check.off_target_days.map((day) => day.date), ['2026-11-15', '2026-11-16']);
  assert.strictEqual(check.target_units_per_day, 2);
  assert.strictEqual(check.scope, CADENCE_SCOPE);
});

test('PAID IS NEVER COUNTED: the policy module imports no ad model and states the scope on every report', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'agent', 'core', 'contentCadencePolicy.js'), 'utf8');
  assert.ok(!/require\(['"]\.\/adCampaignModel['"]\)/.test(source));
  assert.ok(!/require\(['"]\.\/advertising/.test(source));
  // Only `date` is read off a record - a record's platform, budget or kind never changes the count.
  assert.ok(CADENCE_SCOPE.includes('organic'));
  assert.ok(CADENCE_SCOPE.includes('paid ad campaigns are never counted'));
  const check = checkDailyContentCadence([calendarEntry('2026-11-14', 'instagram')], 2);
  assert.strictEqual(check.scope, CADENCE_SCOPE);
  assert.ok(describeCadenceLimitations(check)[0].includes('paid ad campaigns are never counted'));
});

test('a record with no usable date is not counted, and an all-undated set reports nothing', () => {
  const check = checkDailyContentCadence(
    [calendarEntry('2026-11-14', 'instagram'), { date: '   ' }, { platform: 'tiktok' }, null, 'nope'],
    2
  );
  assert.deepStrictEqual(check.days.map((day) => [day.date, day.planned_units]), [['2026-11-14', 1]]);
  assert.strictEqual(checkDailyContentCadence([{ date: '' }, null], 2), null);
  assert.strictEqual(checkDailyContentCadence([], 2), null);
  assert.strictEqual(checkDailyContentCadence('not an array', 2), null);
});

// ---------------------------------------------------------------------------------
// REPORTED, NEVER ENFORCED.
// ---------------------------------------------------------------------------------

test('an on-target day produces NO limitation - a limitation is only for something a reader must know', () => {
  const onTarget = checkDailyContentCadence(
    [calendarEntry('2026-11-14', 'instagram'), calendarEntry('2026-11-14', 'tiktok')],
    2
  );
  assert.deepStrictEqual(describeCadenceLimitations(onTarget), []);
  assert.deepStrictEqual(describeCadenceLimitations(null), []);
  assert.deepStrictEqual(describeCadenceLimitations('nope'), []);
});

test('an off-target limitation names the date, both numbers, the direction, and the config path', () => {
  const [line] = describeCadenceLimitations(checkDailyContentCadence([calendarEntry('2026-11-14', 'instagram')], 2));
  assert.ok(line.includes('2026-11-14'));
  assert.ok(line.includes('is under the configured target'));
  assert.ok(line.includes('1 unit(s) planned against a target of 2 per day'));
  assert.ok(line.includes(`configuration/business.yaml ${CADENCE_CONFIG_PATH}`));
  assert.ok(line.includes('the calendar is not rejected'));
  const [over] = describeCadenceLimitations(
    checkDailyContentCadence(
      [calendarEntry('2026-11-14', 'a'), calendarEntry('2026-11-14', 'b'), calendarEntry('2026-11-14', 'c')],
      2
    )
  );
  assert.ok(over.includes('is over the configured target'));
});

test('NEVER ENFORCED: an off-target calendar still succeeds, with every entry it was given intact', () => {
  const result = analyzeContentCalendar({
    entryReference: '(entry 1)',
    date: '2026-11-14',
    platform: 'instagram',
    evidence: ['(placeholder prior-post performance)'],
    dailyContentUnits: 2,
  });
  // One entry against a target of 2 - reported, and that is all that happens to it.
  assert.strictEqual(cadenceLines(result).length, 1);
  assert.strictEqual(result.specialized_records.length, 1);
  assert.strictEqual(result.specialized_records[0].entry_reference, '(entry 1)');
  // Nothing was added to reach the target and nothing was removed.
  const overshoot = analyzeContentCalendar({
    entryReference: '(entry 1)',
    date: '2026-11-14',
    platform: 'instagram',
    dailyContentUnits: 2,
    plannedEntries: [
      { entryReference: '(entry 2)', date: '2026-11-14', platform: 'tiktok' },
      { entryReference: '(entry 3)', date: '2026-11-14', platform: 'pinterest' },
    ],
  });
  assert.strictEqual(overshoot.specialized_records.length, 3);
  assert.ok(cadenceLines(overshoot)[0].includes('is over the configured target'));
});

// ---------------------------------------------------------------------------------
// THE CAPABILITY AND ITS TOOL.
// ---------------------------------------------------------------------------------

test('plannedEntries go through the SAME builder and validation as the primary entry', () => {
  const result = analyzeContentCalendar({
    entryReference: '(entry 1)',
    date: '2026-11-14',
    platform: 'instagram',
    dailyContentUnits: 2,
    plannedEntries: [{ entryReference: '(entry 2)', date: '2026-11-14', platform: 'tiktok' }],
  });
  assert.deepStrictEqual(cadenceLines(result), [], 'two entries on one date is on target');
  assert.deepStrictEqual(
    result.specialized_records.map((record) => [record.entry_reference, record.platform]),
    [['(entry 1)', 'instagram'], ['(entry 2)', 'tiktok']]
  );
  // A planned entry missing a required field is refused exactly like the primary one is.
  assert.throws(
    () =>
      analyzeContentCalendar({
        entryReference: '(entry 1)',
        date: '2026-11-14',
        platform: 'instagram',
        plannedEntries: [{ entryReference: '(entry 2)', date: '2026-11-14' }],
      }),
    /requires a non-empty `platform` string/
  );
  // And an unknown platform is refused there too - no second, looser path exists.
  assert.throws(
    () =>
      analyzeContentCalendar({
        entryReference: '(entry 1)',
        date: '2026-11-14',
        platform: 'instagram',
        plannedEntries: [{ entryReference: '(entry 2)', date: '2026-11-14', platform: 'snapchat' }],
      }),
    /platform must be one of/
  );
  assert.throws(
    () =>
      analyzeContentCalendar({
        entryReference: '(entry 1)',
        date: '2026-11-14',
        platform: 'instagram',
        plannedEntries: 'not an array',
      }),
    /requires `plannedEntries` to be an array when supplied/
  );
});

test('BOTH NEW PARAMS ARE OPTIONAL: without them the capability behaves exactly as before', () => {
  const before = analyzeContentCalendar({
    entryReference: '(entry 1)',
    date: '2026-11-14',
    platform: 'instagram',
    evidence: ['(placeholder)'],
  });
  assert.deepStrictEqual(cadenceLines(before), []);
  assert.strictEqual(before.specialized_records.length, 1);
  // The pre-existing Marketing campaign context path is untouched by either new param.
  const withCampaign = analyzeContentCalendar({
    entryReference: '(entry 1)',
    date: '2026-11-14',
    platform: 'instagram',
    campaignContext: { campaignReference: '(a campaign)', evidence: ['(placeholder)'] },
    dailyContentUnits: 2,
  });
  assert.strictEqual(withCampaign.specialized_records.length, 2, 'calendar entry + campaign plan record');
  assert.strictEqual(withCampaign.specialized_records[0].campaign, '(a campaign)');
  // The campaign plan record is NOT a content unit - it must not inflate the count.
  assert.ok(cadenceLines(withCampaign)[0].includes('1 unit(s) planned'));
});

test('the tool wrapper relays cadence without disturbing its own evidence-based status', () => {
  const offTarget = runContentCalendarTool({
    entryReference: '(entry 1)',
    date: '2026-11-14',
    platform: 'instagram',
    evidence: ['(placeholder prior-post performance)'],
    dailyContentUnits: 2,
  });
  // A cadence limitation is not an evidence gap: status still reflects evidence only.
  assert.strictEqual(offTarget.status, 'success');
  assert.strictEqual(cadenceLines(offTarget.result).length, 1);

  const noEvidence = runContentCalendarTool({
    entryReference: '(entry 1)',
    date: '2026-11-14',
    platform: 'instagram',
    dailyContentUnits: 2,
  });
  assert.strictEqual(noEvidence.status, 'empty');

  const partial = runContentCalendarTool({
    entryReference: '(entry 1)',
    date: '2026-11-14',
    platform: 'instagram',
    evidence: ['(placeholder)'],
    dailyContentUnits: 2,
    plannedEntries: [{ entryReference: '(entry 2)', date: '2026-11-14', platform: 'tiktok' }],
  });
  assert.strictEqual(partial.status, 'partial', 'one entry with evidence, one without');
  assert.deepStrictEqual(cadenceLines(partial.result), [], 'and 2 entries on the date is on target');
});

test('the registry declares both new params as OPTIONAL, so neither can block routing', () => {
  const task = getCapabilityTask('social_advertising', 'content_calendar');
  assert.deepStrictEqual(task.input_contract.required, ['entryReference', 'date', 'platform']);
  for (const field of ['dailyContentUnits', 'plannedEntries', 'plannedEntries[].platform']) {
    assert.ok(task.input_contract.optional.includes(field), `${field} is not declared optional`);
  }
});

// ---------------------------------------------------------------------------------
// THE ORCHESTRATOR THREADS THE CONFIGURED TARGET IN - THE CAPABILITY NEVER READS IT.
// ---------------------------------------------------------------------------------

test('THE CAPABILITY READS NO CONFIG FILE - the target only ever arrives as a param', () => {
  const agentSource = fs.readFileSync(
    path.join(__dirname, '..', '..', 'agent', 'core', 'socialAdvertisingAgent.js'),
    'utf8'
  );
  const policySource = fs.readFileSync(
    path.join(__dirname, '..', '..', 'agent', 'core', 'contentCadencePolicy.js'),
    'utf8'
  );
  // Comment lines legitimately NAME the config path (that is the documentation); only
  // real code may not reach for it, so comments are stripped before scanning - the same
  // comment-stripping this project's other anti-duplication scans already use.
  const codeOnly = (source) => source.replace(/^\s*\/\/.*$/gm, '');
  for (const [label, source] of [['the agent', agentSource], ['the policy', policySource]]) {
    assert.ok(
      !/loadBusinessConfig|require\(['"]fs['"]\)|readFileSync/.test(codeOnly(source)),
      `${label} reads config or the filesystem directly`
    );
  }
  // And the policy does no counting the agent duplicates: exactly one call site each.
  const callSites = (line) => (agentSource.match(new RegExp(`\\b${line}\\(`, 'g')) || []).length;
  assert.strictEqual(callSites('checkDailyContentCadence'), 1);
  assert.strictEqual(callSites('describeCadenceLimitations'), 1);
});

test('deriveBusinessConfigContext supplies the target for content_calendar, and only for it', () => {
  assert.deepStrictEqual(deriveBusinessConfigContext({ toCapabilityId: 'content_calendar' }), { dailyContentUnits: 2 });
  // The capability this function already served is completely unchanged.
  assert.ok(Array.isArray(deriveBusinessConfigContext({ toCapabilityId: 'global_market_opportunity_analysis' }).markets));
  // No other capability is given a cadence it never asked for.
  for (const id of ['instagram', 'content_generation', 'meta_ads', 'advertising_strategy', 'campaign_planning']) {
    assert.deepStrictEqual(deriveBusinessConfigContext({ toCapabilityId: id }), {}, `${id} received config context`);
  }
});

test('a missing, unparsable, or cadence-less business.yaml yields {} - never a fabricated target', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-config-'));
  try {
    const missing = path.join(dir, 'does-not-exist.yaml');
    assert.deepStrictEqual(deriveBusinessConfigContext({ toCapabilityId: 'content_calendar', configPath: missing }), {});

    const noCadence = path.join(dir, 'no-cadence.yaml');
    fs.writeFileSync(noCadence, 'business_name: "A business with no social cadence"\n', 'utf8');
    assert.deepStrictEqual(deriveBusinessConfigContext({ toCapabilityId: 'content_calendar', configPath: noCadence }), {});

    const blank = path.join(dir, 'blank-cadence.yaml');
    fs.writeFileSync(blank, 'social_content:\n  daily_content_units:\n', 'utf8');
    assert.deepStrictEqual(deriveBusinessConfigContext({ toCapabilityId: 'content_calendar', configPath: blank }), {});

    const unusable = path.join(dir, 'unusable-cadence.yaml');
    fs.writeFileSync(unusable, 'social_content:\n  daily_content_units: "two"\n', 'utf8');
    assert.deepStrictEqual(deriveBusinessConfigContext({ toCapabilityId: 'content_calendar', configPath: unusable }), {});

    // A DIFFERENT business gets ITS number, not this project's - the whole point of
    // configuring it (CLAUDE.md rule 14).
    const otherBusiness = path.join(dir, 'other-business.yaml');
    fs.writeFileSync(otherBusiness, 'social_content:\n  daily_content_units: 5\n', 'utf8');
    assert.deepStrictEqual(
      deriveBusinessConfigContext({ toCapabilityId: 'content_calendar', configPath: otherBusiness }),
      { dailyContentUnits: 5 }
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------
// REAL ROUTING, END TO END.
// ---------------------------------------------------------------------------------

const suite = testAsync(
  'REAL ROUTING: the growth workflow reaches content_calendar and reports the configured cadence',
  async () => {
    const { runGrowthWorkflow } = require('../../agent/core/growthWorkflowOrchestrator');
    const result = await runGrowthWorkflow(null, {
      social_advertising: {
        entryReference: '(Example calendar entry, 2026-09-01, Instagram)',
        date: '2026-09-01',
        platform: 'instagram',
      },
    });
    const step = result.plan.find((s) => s.inputs && s.inputs.capability_id === 'content_calendar');
    assert.ok(step, 'the workflow must reach the content_calendar capability');
    assert.strictEqual(step.selected_specialist.id, 'social_advertising');
    assert.strictEqual(step.inputs.tool_id, 'content_calendar_generation');
    // The target came out of configuration/business.yaml through the real dispatch path -
    // nothing in this test handed it in.
    const lines = cadenceLines(step.outputs.result);
    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0].includes('2026-09-01'));
    assert.ok(lines[0].includes('1 unit(s) planned against a target of 2 per day'));
  }
);

suite.then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
});
