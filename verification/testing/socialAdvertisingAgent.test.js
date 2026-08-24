'use strict';

const assert = require('node:assert');
const {
  analyzeInstagram,
  analyzeFacebook,
  analyzeTiktok,
  analyzePinterest,
  analyzeYoutube,
  analyzeMetaAds,
  analyzeGoogleAds,
  analyzeTiktokAds,
  analyzeSocialMediaStrategy,
  analyzeContentGeneration,
  analyzeContentCalendar,
  analyzeAdvertisingStrategy,
  analyzeAdvertisingPerformance,
  runSocialAdvertisingAgent,
  retrieveSocialAdvertisingData,
} = require('../../agent/core/socialAdvertisingAgent');
const { validateSocialAdvertisingAgentResultShape } = require('../../agent/core/socialAdvertisingAgentResultModel');

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

function assertValidResult(result) {
  const validation = validateSocialAdvertisingAgentResultShape(result);
  assert.strictEqual(validation.valid, true, `expected valid, got errors: ${validation.errors.join(', ')}`);
}

// --- instagram ---------------------------------------------------------------------------

test('analyzeInstagram requires a non-empty contentReference', () => {
  assert.throws(() => analyzeInstagram({}), /requires a non-empty `contentReference`/);
});

test('analyzeInstagram pins platform to instagram regardless of caller input', () => {
  const result = analyzeInstagram({ contentReference: '(Example post)', platform: 'facebook' });
  assert.strictEqual(result.capability, 'instagram');
  assert.strictEqual(result.specialized_records[0].platform, 'instagram');
});

test('analyzeInstagram produces a valid result composing a socialContentModel.js record', () => {
  const result = analyzeInstagram({
    contentReference: '(Example launch post)',
    contentType: 'reel',
    objective: 'Drive awareness.',
    caption: 'Stay warm this winter.',
  });
  assertValidResult(result);
  const record = result.specialized_records[0];
  assert.strictEqual(record.content_type, 'reel');
  assert.strictEqual(record.caption, 'Stay warm this winter.');
});

test('analyzeInstagram reports empty when no evidence is supplied, and surfaces supplied evidence otherwise', () => {
  const withoutEvidence = analyzeInstagram({ contentReference: '(Example post)' });
  assert.ok(withoutEvidence.limitations.some((l) => l.startsWith('No evidence was supplied for')));
  assert.deepStrictEqual(withoutEvidence.evidence, []);

  const withEvidence = analyzeInstagram({ contentReference: '(Example post)', evidence: ['prior post performance'] });
  assert.deepStrictEqual(withEvidence.evidence, ['prior post performance']);
});

test('analyzeInstagram never invents a caption or hashtags that were not supplied', () => {
  const result = analyzeInstagram({ contentReference: '(Example post)' });
  const record = result.specialized_records[0];
  assert.strictEqual(record.caption, '');
  assert.deepStrictEqual(record.hashtags, []);
});

// --- facebook / tiktok / pinterest / youtube --------------------------------------------

test('analyzeFacebook pins platform to facebook', () => {
  const result = analyzeFacebook({ contentReference: '(Example post)' });
  assert.strictEqual(result.capability, 'facebook');
  assert.strictEqual(result.specialized_records[0].platform, 'facebook');
});

test('analyzeTiktok pins platform to tiktok', () => {
  const result = analyzeTiktok({ contentReference: '(Example video)' });
  assert.strictEqual(result.capability, 'tiktok');
  assert.strictEqual(result.specialized_records[0].platform, 'tiktok');
});

test('analyzePinterest pins platform to pinterest', () => {
  const result = analyzePinterest({ contentReference: '(Example pin)' });
  assert.strictEqual(result.capability, 'pinterest');
  assert.strictEqual(result.specialized_records[0].platform, 'pinterest');
});

test('analyzeYoutube pins platform to youtube', () => {
  const result = analyzeYoutube({ contentReference: '(Example video)' });
  assert.strictEqual(result.capability, 'youtube');
  assert.strictEqual(result.specialized_records[0].platform, 'youtube');
});

// --- meta_ads / google_ads / tiktok_ads ----------------------------------------------------

test('analyzeMetaAds requires a non-empty campaignReference', () => {
  assert.throws(() => analyzeMetaAds({}), /requires a non-empty `campaignReference`/);
});

test('analyzeMetaAds pins platform to meta_ads regardless of caller input', () => {
  const result = analyzeMetaAds({ campaignReference: '(Example campaign)', platform: 'google_ads' });
  assert.strictEqual(result.capability, 'meta_ads');
  assert.strictEqual(result.specialized_records[0].platform, 'meta_ads');
});

test('analyzeMetaAds composes an adCampaignModel.js record with budget and bidding_strategy', () => {
  const result = analyzeMetaAds({
    campaignReference: '(Example launch campaign)',
    objective: 'Drive first-week sales.',
    audience: 'Budget-conscious weekend hikers.',
    budget: '$500/month.',
    adCreative: 'Lifestyle photography.',
    biddingStrategy: 'Cost-per-click.',
    cta: 'Shop now.',
    kpi: ['Click-through rate'],
    measurementPlan: ['Weekly review in Meta Ads Manager'],
  });
  assertValidResult(result);
  const record = result.specialized_records[0];
  assert.strictEqual(record.budget, '$500/month.');
  assert.strictEqual(record.bidding_strategy, 'Cost-per-click.');
  assert.deepStrictEqual(record.kpi, ['Click-through rate']);
  assert.ok(result.findings.includes('Shop now.'));
});

test('analyzeMetaAds never invents a budget, bidding strategy, or KPI that was not supplied', () => {
  const result = analyzeMetaAds({ campaignReference: '(Example campaign)' });
  const record = result.specialized_records[0];
  assert.strictEqual(record.budget, '');
  assert.strictEqual(record.bidding_strategy, '');
  assert.deepStrictEqual(record.kpi, []);
});

test('analyzeMetaAds never launches a campaign - the result always carries that limitation', () => {
  const result = analyzeMetaAds({ campaignReference: '(Example campaign)' });
  assert.ok(result.limitations.some((l) => l.includes('not launched automatically')));
});

test('analyzeGoogleAds pins platform to google_ads', () => {
  const result = analyzeGoogleAds({ campaignReference: '(Example campaign)' });
  assert.strictEqual(result.capability, 'google_ads');
  assert.strictEqual(result.specialized_records[0].platform, 'google_ads');
});

test('analyzeTiktokAds pins platform to tiktok_ads', () => {
  const result = analyzeTiktokAds({ campaignReference: '(Example campaign)' });
  assert.strictEqual(result.capability, 'tiktok_ads');
  assert.strictEqual(result.specialized_records[0].platform, 'tiktok_ads');
});

// --- social_media_strategy -----------------------------------------------------------------

test('analyzeSocialMediaStrategy requires a non-empty strategyReference', () => {
  assert.throws(() => analyzeSocialMediaStrategy({}), /requires a non-empty `strategyReference`/);
});

test('analyzeSocialMediaStrategy produces a valid result composing a socialMediaStrategyModel.js record', () => {
  const result = analyzeSocialMediaStrategy({
    strategyReference: '(Example Q4 winter strategy)',
    objective: 'Grow winter jacket line awareness.',
    audience: 'Budget-conscious weekend hikers.',
    contentPillars: ['Product education', 'Customer stories'],
    platformSelection: ['instagram', 'tiktok', 'meta_ads'],
    postingStrategy: '4x/week organic, always-on ads.',
    contentThemes: ['Cold-weather adventure'],
    campaignThemes: ['Winter launch'],
    kpis: ['Engagement rate', 'Return on ad spend'],
  });
  assert.strictEqual(result.capability, 'social_media_strategy');
  assertValidResult(result);
  const record = result.specialized_records[0];
  assert.deepStrictEqual(record.content_pillars, ['Product education', 'Customer stories']);
  assert.deepStrictEqual(record.platform_selection, ['instagram', 'tiktok', 'meta_ads']);
  assert.deepStrictEqual(record.kpis, ['Engagement rate', 'Return on ad spend']);
  assert.ok(result.findings.includes('Product education'));
  assert.ok(result.findings.includes('Engagement rate'));
});

test('analyzeSocialMediaStrategy never invents content pillars, platform selection, or KPIs that were not supplied', () => {
  const result = analyzeSocialMediaStrategy({ strategyReference: '(Example strategy)' });
  const record = result.specialized_records[0];
  assert.deepStrictEqual(record.content_pillars, []);
  assert.deepStrictEqual(record.platform_selection, []);
  assert.deepStrictEqual(record.kpis, []);
});

test('analyzeSocialMediaStrategy rejects a platform_selection entry outside the 8 in-scope platforms', () => {
  assert.throws(
    () => analyzeSocialMediaStrategy({ strategyReference: '(Example strategy)', platformSelection: ['snapchat'] }),
    /invalid social media strategy record/
  );
});

test('analyzeSocialMediaStrategy never executes automatically - the result always carries that limitation', () => {
  const result = analyzeSocialMediaStrategy({ strategyReference: '(Example strategy)' });
  assert.ok(result.limitations.some((l) => l.includes('not executed automatically')));
});

test('analyzeSocialMediaStrategy reports empty when no evidence is supplied, and surfaces supplied evidence otherwise', () => {
  const withoutEvidence = analyzeSocialMediaStrategy({ strategyReference: '(Example strategy)' });
  assert.ok(withoutEvidence.limitations.some((l) => l.startsWith('No evidence was supplied for')));

  const withEvidence = analyzeSocialMediaStrategy({
    strategyReference: '(Example strategy)',
    evidence: ['prior quarter performance'],
  });
  assert.deepStrictEqual(withEvidence.evidence, ['prior quarter performance']);
});

// --- content_generation --------------------------------------------------------------------

test('analyzeContentGeneration requires a non-empty platform', () => {
  assert.throws(() => analyzeContentGeneration({ contentReference: '(Example content)' }), /requires a non-empty `platform`/);
});

test('analyzeContentGeneration requires a non-empty contentReference', () => {
  assert.throws(() => analyzeContentGeneration({ platform: 'tiktok' }), /requires a non-empty `contentReference`/);
});

test('analyzeContentGeneration rejects a platform outside the 5 in-scope social platforms', () => {
  assert.throws(
    () => analyzeContentGeneration({ platform: 'snapchat', contentReference: '(Example content)' }),
    /invalid platform content record/
  );
});

test('analyzeContentGeneration produces a valid result composing a platformContentModel.js record adapted to the selected platform', () => {
  const result = analyzeContentGeneration({
    platform: 'tiktok',
    contentReference: '(Example jacket launch content set)',
    objective: 'Drive awareness.',
    targetAudience: 'Budget-conscious weekend hikers.',
    hooks: ['You\'re about to see the warmest $80 jacket on the internet.'],
    captions: ['Stay warm this winter without breaking the bank.'],
    ctas: ['Shop the winter collection - link in bio.'],
    contentIdeas: ['Cold-room stress test vs. a $300 competitor jacket.'],
    shortFormVideoConcepts: ['15-second cold-room challenge.'],
    carouselConcepts: ['5-slide cutaway breakdown.'],
    creativeBriefs: ['Fast-paced, natural light, UGC-style handheld footage.'],
    platformAdaptationNotes: 'Vertical 9:16, hook within first 2 seconds, on-screen captions.',
  });
  assert.strictEqual(result.capability, 'content_generation');
  assertValidResult(result);
  const record = result.specialized_records[0];
  assert.strictEqual(record.platform, 'tiktok');
  assert.deepStrictEqual(record.hooks, ['You\'re about to see the warmest $80 jacket on the internet.']);
  assert.deepStrictEqual(record.short_form_video_concepts, ['15-second cold-room challenge.']);
  assert.deepStrictEqual(record.carousel_concepts, ['5-slide cutaway breakdown.']);
  assert.deepStrictEqual(record.creative_briefs, ['Fast-paced, natural light, UGC-style handheld footage.']);
  assert.strictEqual(record.platform_adaptation_notes, 'Vertical 9:16, hook within first 2 seconds, on-screen captions.');
  assert.ok(result.findings.includes('You\'re about to see the warmest $80 jacket on the internet.'));
});

test('analyzeContentGeneration never invents hooks, captions, CTAs, or concepts that were not supplied', () => {
  const result = analyzeContentGeneration({ platform: 'instagram', contentReference: '(Example content)' });
  const record = result.specialized_records[0];
  assert.deepStrictEqual(record.hooks, []);
  assert.deepStrictEqual(record.captions, []);
  assert.deepStrictEqual(record.ctas, []);
  assert.deepStrictEqual(record.content_ideas, []);
  assert.deepStrictEqual(record.short_form_video_concepts, []);
  assert.deepStrictEqual(record.carousel_concepts, []);
  assert.deepStrictEqual(record.creative_briefs, []);
  assert.strictEqual(record.platform_adaptation_notes, '');
});

test('analyzeContentGeneration never publishes automatically - the result always carries that limitation', () => {
  const result = analyzeContentGeneration({ platform: 'instagram', contentReference: '(Example content)' });
  assert.ok(result.limitations.some((l) => l.includes('not published automatically')));
});

test('analyzeContentGeneration reports empty when no evidence is supplied, and surfaces supplied evidence otherwise', () => {
  const withoutEvidence = analyzeContentGeneration({ platform: 'instagram', contentReference: '(Example content)' });
  assert.ok(withoutEvidence.limitations.some((l) => l.startsWith('No evidence was supplied for')));

  const withEvidence = analyzeContentGeneration({
    platform: 'instagram',
    contentReference: '(Example content)',
    evidence: ['prior post performance'],
  });
  assert.deepStrictEqual(withEvidence.evidence, ['prior post performance']);
});

// --- content_calendar -----------------------------------------------------------------------

test('analyzeContentCalendar requires a non-empty entryReference', () => {
  assert.throws(
    () => analyzeContentCalendar({ date: '2026-11-14', platform: 'tiktok' }),
    /requires a non-empty `entryReference`/
  );
});

test('analyzeContentCalendar requires a non-empty date', () => {
  assert.throws(
    () => analyzeContentCalendar({ entryReference: '(Example entry)', platform: 'tiktok' }),
    /requires a non-empty `date`/
  );
});

test('analyzeContentCalendar requires a non-empty platform', () => {
  assert.throws(
    () => analyzeContentCalendar({ entryReference: '(Example entry)', date: '2026-11-14' }),
    /requires a non-empty `platform`/
  );
});

test('analyzeContentCalendar rejects a platform outside the 5 in-scope social platforms', () => {
  assert.throws(
    () => analyzeContentCalendar({ entryReference: '(Example entry)', date: '2026-11-14', platform: 'snapchat' }),
    /invalid content calendar record/
  );
});

test('analyzeContentCalendar produces a valid result composing a contentCalendarModel.js record', () => {
  const result = analyzeContentCalendar({
    entryReference: '(Example Nov 14 tiktok post)',
    date: '2026-11-14',
    platform: 'tiktok',
    contentType: 'video',
    topic: 'Cold-weather stress test.',
    hook: 'Warmest $80 jacket on the internet.',
    cta: 'Shop now.',
    campaign: '(Example winter jacket launch)',
    product: '(Example insulated jacket)',
    kpi: ['Engagement rate'],
  });
  assert.strictEqual(result.capability, 'content_calendar');
  assertValidResult(result);
  const record = result.specialized_records[0];
  assert.strictEqual(record.date, '2026-11-14');
  assert.strictEqual(record.platform, 'tiktok');
  assert.strictEqual(record.topic, 'Cold-weather stress test.');
  assert.strictEqual(record.hook, 'Warmest $80 jacket on the internet.');
  assert.strictEqual(record.cta, 'Shop now.');
  assert.strictEqual(record.campaign, '(Example winter jacket launch)');
  assert.strictEqual(record.product, '(Example insulated jacket)');
  assert.deepStrictEqual(record.kpi, ['Engagement rate']);
  assert.ok(result.findings.includes('Warmest $80 jacket on the internet.'));
});

test('analyzeContentCalendar never invents a topic, hook, cta, campaign, product, or kpi that was not supplied', () => {
  const result = analyzeContentCalendar({ entryReference: '(Example entry)', date: '2026-11-14', platform: 'instagram' });
  const record = result.specialized_records[0];
  assert.strictEqual(record.topic, '');
  assert.strictEqual(record.hook, '');
  assert.strictEqual(record.cta, '');
  assert.strictEqual(record.campaign, '');
  assert.strictEqual(record.product, '');
  assert.deepStrictEqual(record.kpi, []);
});

test('analyzeContentCalendar never posts or schedules automatically - the result always carries that limitation', () => {
  const result = analyzeContentCalendar({ entryReference: '(Example entry)', date: '2026-11-14', platform: 'instagram' });
  assert.ok(result.limitations.some((l) => l.includes('not posted or scheduled automatically')));
});

test('analyzeContentCalendar reports empty when no evidence is supplied, and surfaces supplied evidence otherwise', () => {
  const withoutEvidence = analyzeContentCalendar({ entryReference: '(Example entry)', date: '2026-11-14', platform: 'instagram' });
  assert.ok(withoutEvidence.limitations.some((l) => l.startsWith('No evidence was supplied for')));

  const withEvidence = analyzeContentCalendar({
    entryReference: '(Example entry)',
    date: '2026-11-14',
    platform: 'instagram',
    evidence: ['prior post performance'],
  });
  assert.deepStrictEqual(withEvidence.evidence, ['prior post performance']);
});

// --- content_calendar: Marketing Agent campaign context -------------------------------------

test('analyzeContentCalendar derives campaign from Marketing Agent campaignContext when campaign is not explicitly supplied', () => {
  const result = analyzeContentCalendar({
    entryReference: '(Example entry)',
    date: '2026-11-14',
    platform: 'instagram',
    campaignContext: {
      campaignReference: '(Example winter jacket launch campaign)',
      objective: 'Drive first-week sales.',
      audience: 'Budget-conscious weekend hikers.',
    },
  });
  const [calendarRecord, campaignRecord] = result.specialized_records;
  assert.strictEqual(calendarRecord.campaign, '(Example winter jacket launch campaign)');
  assert.strictEqual(campaignRecord.campaign_reference, '(Example winter jacket launch campaign)');
  assert.strictEqual(campaignRecord.objective, 'Drive first-week sales.');
  assert.ok(result.findings.includes('Drive first-week sales.'));
  assert.ok(result.findings.includes('Budget-conscious weekend hikers.'));
});

test('analyzeContentCalendar honors an explicitly-supplied campaign over campaignContext', () => {
  const result = analyzeContentCalendar({
    entryReference: '(Example entry)',
    date: '2026-11-14',
    platform: 'instagram',
    campaign: '(Explicit campaign)',
    campaignContext: { campaignReference: '(Example winter jacket launch campaign)' },
  });
  assert.strictEqual(result.specialized_records[0].campaign, '(Explicit campaign)');
});

test('analyzeContentCalendar folds the campaign plan record\'s own evidence into the composed result', () => {
  const result = analyzeContentCalendar({
    entryReference: '(Example entry)',
    date: '2026-11-14',
    platform: 'instagram',
    campaignContext: {
      campaignReference: '(Example winter jacket launch campaign)',
      evidence: ['prior campaign result'],
    },
  });
  assert.ok(result.evidence.includes('prior campaign result'));
});

test('analyzeContentCalendar reuses marketingAgent.js\'s own campaign_plan validation - an invalid campaignContext throws, not silently ignored', () => {
  assert.throws(
    () =>
      analyzeContentCalendar({
        entryReference: '(Example entry)',
        date: '2026-11-14',
        platform: 'instagram',
        campaignContext: {},
      }),
    /requires a non-empty `campaignReference`/
  );
});

test('analyzeContentCalendar rejects a non-object campaignContext', () => {
  assert.throws(
    () =>
      analyzeContentCalendar({
        entryReference: '(Example entry)',
        date: '2026-11-14',
        platform: 'instagram',
        campaignContext: 'not an object',
      }),
    /requires `campaignContext` to be an object/
  );
});

test('analyzeContentCalendar works with no campaignContext at all - campaign stays whatever the caller explicitly set', () => {
  const result = analyzeContentCalendar({ entryReference: '(Example entry)', date: '2026-11-14', platform: 'instagram' });
  assert.strictEqual(result.specialized_records.length, 1);
  assert.strictEqual(result.specialized_records[0].campaign, '');
});

// --- advertising_strategy --------------------------------------------------------------------

test('analyzeAdvertisingStrategy requires a non-empty strategyReference', () => {
  assert.throws(
    () => analyzeAdvertisingStrategy({ campaignObjective: 'Drive sales.' }),
    /requires a non-empty `strategyReference`/
  );
});

test('analyzeAdvertisingStrategy produces a valid result composing an advertisingStrategyModel.js record', () => {
  const result = analyzeAdvertisingStrategy({
    strategyReference: '(Example winter jacket launch strategy)',
    campaignObjective: 'Drive first-week sales.',
    audience: 'Budget-conscious weekend hikers.',
    offer: '15% off for the first week.',
    creativeAngle: 'Warmth without the premium price tag.',
    adCopy: ['The warmest $80 jacket on the internet.'],
    cta: 'Shop the winter collection.',
    budgetRecommendation: '$500/month, reviewed weekly.',
    kpi: ['Return on ad spend'],
    testingPlan: ['A/B test 2 creative angles for 1 week.'],
  });
  assert.strictEqual(result.capability, 'advertising_strategy');
  assertValidResult(result);
  const record = result.specialized_records[0];
  assert.strictEqual(record.campaign_objective, 'Drive first-week sales.');
  assert.strictEqual(record.audience, 'Budget-conscious weekend hikers.');
  assert.strictEqual(record.offer, '15% off for the first week.');
  assert.strictEqual(record.creative_angle, 'Warmth without the premium price tag.');
  assert.deepStrictEqual(record.ad_copy, ['The warmest $80 jacket on the internet.']);
  assert.strictEqual(record.cta, 'Shop the winter collection.');
  assert.strictEqual(record.budget_recommendation, '$500/month, reviewed weekly.');
  assert.deepStrictEqual(record.kpi, ['Return on ad spend']);
  assert.deepStrictEqual(record.testing_plan, ['A/B test 2 creative angles for 1 week.']);
  assert.ok(result.findings.includes('The warmest $80 jacket on the internet.'));
});

test('analyzeAdvertisingStrategy never invents an objective, audience, offer, creative angle, ad copy, CTA, budget, KPI, or testing plan that was not supplied', () => {
  const result = analyzeAdvertisingStrategy({ strategyReference: '(Example strategy)' });
  const record = result.specialized_records[0];
  assert.strictEqual(record.campaign_objective, '');
  assert.strictEqual(record.audience, '');
  assert.strictEqual(record.offer, '');
  assert.strictEqual(record.creative_angle, '');
  assert.deepStrictEqual(record.ad_copy, []);
  assert.strictEqual(record.cta, '');
  assert.strictEqual(record.budget_recommendation, '');
  assert.deepStrictEqual(record.kpi, []);
  assert.deepStrictEqual(record.testing_plan, []);
});

test('analyzeAdvertisingStrategy never spends budget or launches a campaign - the result always carries that limitation', () => {
  const result = analyzeAdvertisingStrategy({ strategyReference: '(Example strategy)' });
  assert.ok(result.limitations.some((l) => l.includes('No advertising budget is spent') && l.includes('no campaign is launched automatically')));
});

test('analyzeAdvertisingStrategy reports empty when no evidence is supplied, and surfaces supplied evidence otherwise', () => {
  const withoutEvidence = analyzeAdvertisingStrategy({ strategyReference: '(Example strategy)' });
  assert.ok(withoutEvidence.limitations.some((l) => l.startsWith('No evidence was supplied for')));

  const withEvidence = analyzeAdvertisingStrategy({
    strategyReference: '(Example strategy)',
    evidence: ['prior campaign result'],
  });
  assert.deepStrictEqual(withEvidence.evidence, ['prior campaign result']);
});

// --- advertising_performance ------------------------------------------------------------------

test('analyzeAdvertisingPerformance requires a non-empty performanceReference', () => {
  assert.throws(
    () => analyzeAdvertisingPerformance({ actualMetrics: { impressions: 10000 } }),
    /requires a non-empty `performanceReference`/
  );
});

test('analyzeAdvertisingPerformance rejects an unknown metric key', () => {
  assert.throws(
    () => analyzeAdvertisingPerformance({ performanceReference: '(Example)', actualMetrics: { likes: 500 } }),
    /invalid advertising performance record/
  );
});

test('analyzeAdvertisingPerformance produces a valid result composing an advertisingPerformanceModel.js record', () => {
  const result = analyzeAdvertisingPerformance({
    performanceReference: '(Example winter jacket launch - week 1 performance)',
    campaignReference: '(Example winter jacket launch campaign)',
    actualMetrics: {
      impressions: 10000,
      clicks: 250,
      spend: 500,
      conversions: 20,
      revenue: 1000,
    },
  });
  assert.strictEqual(result.capability, 'advertising_performance');
  assertValidResult(result);
  const record = result.specialized_records[0];
  assert.strictEqual(record.campaign_reference, '(Example winter jacket launch campaign)');
  assert.deepStrictEqual(record.actual_metrics, {
    impressions: 10000,
    clicks: 250,
    spend: 500,
    conversions: 20,
    revenue: 1000,
  });
  assert.ok(result.findings.includes('Actual - impressions: 10000'));
});

test('analyzeAdvertisingPerformance keeps actual metrics, calculated metrics, and recommendations structurally separate', () => {
  const result = analyzeAdvertisingPerformance({
    performanceReference: '(Example)',
    actualMetrics: { impressions: 10000, clicks: 250, spend: 500, conversions: 20, revenue: 1000 },
    recommendations: ['Increase budget - the campaign is beating its ROAS target.'],
  });
  const record = result.specialized_records[0];
  assert.deepStrictEqual(record.actual_metrics, {
    impressions: 10000,
    clicks: 250,
    spend: 500,
    conversions: 20,
    revenue: 1000,
  });
  assert.deepStrictEqual(record.calculated_metrics, { ctr: 0.025, cpc: 2, cpm: 50, cpa: 25, roas: 2 });
  // Recommendations never leak into either metrics object - they only ever live in
  // the envelope's own `recommendations` field.
  assert.ok(!('recommendations' in record));
  assert.deepStrictEqual(result.recommendations, ['Increase budget - the campaign is beating its ROAS target.']);
});

test('analyzeAdvertisingPerformance never fabricates a metric it cannot calculate - the gap is named honestly', () => {
  const result = analyzeAdvertisingPerformance({
    performanceReference: '(Example)',
    actualMetrics: { impressions: 10000, clicks: 250 },
  });
  const record = result.specialized_records[0];
  assert.deepStrictEqual(record.calculated_metrics, { ctr: 0.025 });
  assert.ok(
    result.limitations.some(
      (l) => l.includes('could not be calculated') && l.includes('cpc') && l.includes('cpm') && l.includes('cpa') && l.includes('roas')
    )
  );
});

test('analyzeAdvertisingPerformance never invents an actual metric that was not supplied', () => {
  const result = analyzeAdvertisingPerformance({ performanceReference: '(Example)' });
  const record = result.specialized_records[0];
  assert.deepStrictEqual(record.actual_metrics, {});
  assert.deepStrictEqual(record.calculated_metrics, {});
});

test('analyzeAdvertisingPerformance never fetches/estimates automatically - the result always carries that limitation', () => {
  const result = analyzeAdvertisingPerformance({ performanceReference: '(Example)' });
  assert.ok(result.limitations.some((l) => l.includes('No metric is fetched or estimated automatically')));
});

test('analyzeAdvertisingPerformance reports empty when no evidence is supplied, and surfaces supplied evidence otherwise', () => {
  const withoutEvidence = analyzeAdvertisingPerformance({ performanceReference: '(Example)' });
  assert.ok(withoutEvidence.limitations.some((l) => l.startsWith('No evidence was supplied for')));

  const withEvidence = analyzeAdvertisingPerformance({
    performanceReference: '(Example)',
    evidence: ['prior report'],
  });
  assert.deepStrictEqual(withEvidence.evidence, ['prior report']);
});

// --- dispatcher / reuse helper ------------------------------------------------------------

test('runSocialAdvertisingAgent dispatches by capability', () => {
  const result = runSocialAdvertisingAgent({ capability: 'meta_ads', campaignReference: '(Example campaign)' });
  assert.strictEqual(result.capability, 'meta_ads');
});

test('runSocialAdvertisingAgent throws on an unknown capability', () => {
  assert.throws(
    () => runSocialAdvertisingAgent({ capability: 'not_a_real_capability' }),
    /Unknown Social & Advertising capability/
  );
});

test('retrieveSocialAdvertisingData builds social_content and ad_campaign records directly', () => {
  const contentRecords = retrieveSocialAdvertisingData(
    'social_content',
    [{ platform: 'instagram', contentReference: 'x' }],
    'test'
  );
  assert.strictEqual(contentRecords[0].content_reference, 'x');
  const campaignRecords = retrieveSocialAdvertisingData(
    'ad_campaign',
    [{ platform: 'meta_ads', campaignReference: 'x' }],
    'test'
  );
  assert.strictEqual(campaignRecords[0].campaign_reference, 'x');
  const strategyRecords = retrieveSocialAdvertisingData(
    'social_media_strategy',
    [{ strategyReference: 'x' }],
    'test'
  );
  assert.strictEqual(strategyRecords[0].strategy_reference, 'x');
  const platformContentRecords = retrieveSocialAdvertisingData(
    'platform_content',
    [{ platform: 'instagram', contentReference: 'x' }],
    'test'
  );
  assert.strictEqual(platformContentRecords[0].content_reference, 'x');
  const calendarRecords = retrieveSocialAdvertisingData(
    'content_calendar',
    [{ entryReference: 'x', date: '2026-11-14', platform: 'instagram' }],
    'test'
  );
  assert.strictEqual(calendarRecords[0].entry_reference, 'x');
  const advertisingStrategyRecords = retrieveSocialAdvertisingData(
    'advertising_strategy',
    [{ strategyReference: 'x' }],
    'test'
  );
  assert.strictEqual(advertisingStrategyRecords[0].strategy_reference, 'x');
  const advertisingPerformanceRecords = retrieveSocialAdvertisingData(
    'advertising_performance',
    [{ performanceReference: 'x' }],
    'test'
  );
  assert.strictEqual(advertisingPerformanceRecords[0].performance_reference, 'x');
});

test('retrieveSocialAdvertisingData throws on an unknown record kind', () => {
  assert.throws(() => retrieveSocialAdvertisingData('not_a_real_kind', [], 'test'), /unknown record kind/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
