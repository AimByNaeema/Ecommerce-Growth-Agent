'use strict';

const assert = require('node:assert');
const { runPlatformContentTool } = require('../../tools/platformContentTool');

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

test('runPlatformContentTool never throws - returns failed status when researchParams is missing', () => {
  const outcome = runPlatformContentTool(undefined);
  assert.strictEqual(outcome.status, 'failed');
  assert.strictEqual(outcome.result, null);
  assert.ok(outcome.error.includes('No structured research input was supplied'));
});

test('runPlatformContentTool returns failed status when a required field is missing', () => {
  const outcome = runPlatformContentTool({ platform: 'tiktok', contentReference: '' });
  assert.strictEqual(outcome.status, 'failed');
  assert.ok(outcome.error.includes('requires a non-empty'));
});

test('runPlatformContentTool returns failed status for an unknown platform', () => {
  const outcome = runPlatformContentTool({ platform: 'snapchat', contentReference: '(Example content)' });
  assert.strictEqual(outcome.status, 'failed');
  assert.ok(outcome.error.includes('invalid platform content record'));
});

test('runPlatformContentTool returns empty status when no evidence is supplied', () => {
  const outcome = runPlatformContentTool({
    platform: 'tiktok',
    contentReference: '(Example content set)',
    hooks: ['You\'re about to see the warmest $80 jacket on the internet.'],
  });
  assert.strictEqual(outcome.status, 'empty');
  assert.strictEqual(outcome.result.capability, 'content_generation');
});

test('runPlatformContentTool returns success status when evidence is supplied', () => {
  const outcome = runPlatformContentTool({
    platform: 'tiktok',
    contentReference: '(Example content set)',
    hooks: ['You\'re about to see the warmest $80 jacket on the internet.'],
    evidence: ['prior video performance'],
  });
  assert.strictEqual(outcome.status, 'success');
});

test('runPlatformContentTool relays hooks, captions, CTAs, and concepts untouched, tagged to the selected platform', () => {
  const outcome = runPlatformContentTool({
    platform: 'pinterest',
    contentReference: '(Example content set)',
    hooks: ['hook 1'],
    captions: ['caption 1'],
    ctas: ['cta 1'],
    contentIdeas: ['idea 1'],
    shortFormVideoConcepts: ['video concept 1'],
    carouselConcepts: ['carousel concept 1'],
    creativeBriefs: ['brief 1'],
    platformAdaptationNotes: 'Vertical 2:3 image, minimal text overlay.',
  });
  const record = outcome.result.specialized_records[0];
  assert.strictEqual(record.platform, 'pinterest');
  assert.deepStrictEqual(record.hooks, ['hook 1']);
  assert.deepStrictEqual(record.captions, ['caption 1']);
  assert.deepStrictEqual(record.ctas, ['cta 1']);
  assert.deepStrictEqual(record.content_ideas, ['idea 1']);
  assert.deepStrictEqual(record.short_form_video_concepts, ['video concept 1']);
  assert.deepStrictEqual(record.carousel_concepts, ['carousel concept 1']);
  assert.deepStrictEqual(record.creative_briefs, ['brief 1']);
  assert.strictEqual(record.platform_adaptation_notes, 'Vertical 2:3 image, minimal text overlay.');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
