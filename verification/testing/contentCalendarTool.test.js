'use strict';

const assert = require('node:assert');
const { runContentCalendarTool } = require('../../tools/contentCalendarTool');

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

test('runContentCalendarTool never throws - returns failed status when researchParams is missing', () => {
  const outcome = runContentCalendarTool(undefined);
  assert.strictEqual(outcome.status, 'failed');
  assert.strictEqual(outcome.result, null);
  assert.ok(outcome.error.includes('No structured research input was supplied'));
});

test('runContentCalendarTool returns failed status when a required field is missing', () => {
  const outcome = runContentCalendarTool({ entryReference: '', date: '2026-11-14', platform: 'tiktok' });
  assert.strictEqual(outcome.status, 'failed');
  assert.ok(outcome.error.includes('requires a non-empty'));
});

test('runContentCalendarTool returns failed status for an unknown platform', () => {
  const outcome = runContentCalendarTool({ entryReference: '(Example entry)', date: '2026-11-14', platform: 'snapchat' });
  assert.strictEqual(outcome.status, 'failed');
  assert.ok(outcome.error.includes('invalid content calendar record'));
});

test('runContentCalendarTool returns empty status when no evidence is supplied', () => {
  const outcome = runContentCalendarTool({
    entryReference: '(Example Nov 14 tiktok post)',
    date: '2026-11-14',
    platform: 'tiktok',
    topic: 'Cold-weather stress test.',
  });
  assert.strictEqual(outcome.status, 'empty');
  assert.strictEqual(outcome.result.capability, 'content_calendar');
});

test('runContentCalendarTool returns success status when evidence is supplied', () => {
  const outcome = runContentCalendarTool({
    entryReference: '(Example Nov 14 tiktok post)',
    date: '2026-11-14',
    platform: 'tiktok',
    evidence: ['prior post performance'],
  });
  assert.strictEqual(outcome.status, 'success');
});

test('runContentCalendarTool relays date, topic, hook, cta, product, and kpi untouched', () => {
  const outcome = runContentCalendarTool({
    entryReference: '(Example entry)',
    date: '2026-11-14',
    platform: 'instagram',
    contentType: 'reel',
    topic: 'Cold-weather stress test',
    hook: 'Warmest $80 jacket',
    cta: 'Shop now',
    product: '(Example jacket)',
    kpi: ['Engagement rate'],
  });
  const record = outcome.result.specialized_records[0];
  assert.strictEqual(record.date, '2026-11-14');
  assert.strictEqual(record.content_type, 'reel');
  assert.strictEqual(record.topic, 'Cold-weather stress test');
  assert.strictEqual(record.hook, 'Warmest $80 jacket');
  assert.strictEqual(record.cta, 'Shop now');
  assert.strictEqual(record.product, '(Example jacket)');
  assert.deepStrictEqual(record.kpi, ['Engagement rate']);
});

test('runContentCalendarTool derives campaign from Marketing Agent campaignContext when campaign is not explicitly supplied', () => {
  const outcome = runContentCalendarTool({
    entryReference: '(Example entry)',
    date: '2026-11-14',
    platform: 'instagram',
    campaignContext: {
      campaignReference: '(Example winter jacket launch campaign)',
      objective: 'Drive first-week sales.',
    },
  });
  assert.strictEqual(outcome.status, 'empty');
  const [calendarRecord, campaignRecord] = outcome.result.specialized_records;
  assert.strictEqual(calendarRecord.campaign, '(Example winter jacket launch campaign)');
  assert.strictEqual(campaignRecord.campaign_reference, '(Example winter jacket launch campaign)');
});

test('runContentCalendarTool honors an explicitly-supplied campaign over campaignContext', () => {
  const outcome = runContentCalendarTool({
    entryReference: '(Example entry)',
    date: '2026-11-14',
    platform: 'instagram',
    campaign: '(Explicit campaign)',
    campaignContext: { campaignReference: '(Example winter jacket launch campaign)' },
  });
  assert.strictEqual(outcome.result.specialized_records[0].campaign, '(Explicit campaign)');
});

test('runContentCalendarTool returns failed status for an invalid campaignContext', () => {
  const outcome = runContentCalendarTool({
    entryReference: '(Example entry)',
    date: '2026-11-14',
    platform: 'instagram',
    campaignContext: {},
  });
  assert.strictEqual(outcome.status, 'failed');
  assert.ok(outcome.error.includes('requires a non-empty `campaignReference`'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
