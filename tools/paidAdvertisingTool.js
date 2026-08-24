'use strict';

// The paid_advertising_planning tool (tools/toolRegistry.js): connects the
// Chief/Orchestrator to agent/core/socialAdvertisingAgent.js's 3 paid-advertising
// capabilities. Thin wrapper - no new advertising logic is added here, only structured
// input handling, platform dispatch, and an honest outcome status, matching
// tools/marketingAnalysisTool.js's convention exactly.
//
// The orchestrator (agent/core/orchestratorExecutionContract.js) only threads a
// free-text objective through by default; structured input (platform, campaignReference,
// budget, adCreative, evidence, etc.) must arrive via executionRequest.research_params
// (the same optional passthrough every research/SEO/listing/marketing tool uses). When
// it's missing, this tool reports that honestly instead of guessing parameters from
// the objective text.
//
// researchParams.adPlatform selects which capability to run - one of 'meta_ads'
// (default when omitted), 'google_ads', or 'tiktok_ads'.
//
// Returns { status, result, error } - never throws:
//   status 'failed'  - no researchParams supplied, an unknown adPlatform, or a
//                       required field was missing
//   status 'empty'   - valid input, but no evidence/source was supplied
//   status 'success' - valid input, the underlying record ended up evidence-backed
//   status 'partial' - reserved for future multi-record use; today one record in,
//                       one out, so this tool only ever reports 'empty' or 'success'
//                       once input is valid.

const {
  analyzeMetaAds,
  analyzeGoogleAds,
  analyzeTiktokAds,
} = require('../agent/core/socialAdvertisingAgent');

const CAPABILITY_HANDLERS = {
  meta_ads: analyzeMetaAds,
  google_ads: analyzeGoogleAds,
  tiktok_ads: analyzeTiktokAds,
};

function deriveStatus(result) {
  const recordsMissingEvidence = result.limitations.filter((l) =>
    l.startsWith('No evidence was supplied for')
  ).length;
  const total = result.specialized_records.length;
  const recordsWithEvidence = total - recordsMissingEvidence;
  if (recordsWithEvidence === 0) return 'empty';
  if (recordsWithEvidence === total) return 'success';
  return 'partial';
}

function runPaidAdvertisingTool(researchParams) {
  if (!researchParams || typeof researchParams !== 'object') {
    return {
      status: 'failed',
      result: null,
      error:
        'No structured research input was supplied - paid_advertising_planning requires structured parameters (e.g. campaignReference, budget) that a free-text objective cannot provide.',
    };
  }

  const { adPlatform = 'meta_ads', ...params } = researchParams;
  const handler = CAPABILITY_HANDLERS[adPlatform];
  if (!handler) {
    return {
      status: 'failed',
      result: null,
      error: `Unknown adPlatform: ${adPlatform}. Must be one of: ${Object.keys(CAPABILITY_HANDLERS).join(', ')}`,
    };
  }

  try {
    const result = handler(params);
    return { status: deriveStatus(result), result, error: null };
  } catch (err) {
    return { status: 'failed', result: null, error: err.message };
  }
}

module.exports = { runPaidAdvertisingTool };

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - paid_advertising_planning tool:\n');

  const cases = {
    'no researchParams': undefined,
    'unknown adPlatform (failed)': { adPlatform: 'not_a_real_platform' },
    'missing required field (failed)': { campaignReference: '' },
    'no evidence supplied (empty)': {
      adPlatform: 'meta_ads',
      campaignReference: '(Example winter jacket launch campaign)',
      objective: 'Drive first-week sales (caller-supplied placeholder).',
    },
    'evidence supplied (success)': {
      adPlatform: 'meta_ads',
      campaignReference: '(Example winter jacket launch campaign)',
      objective: 'Drive first-week sales (caller-supplied placeholder).',
      evidence: ['(placeholder prior-campaign result)'],
    },
  };

  for (const [label, researchParams] of Object.entries(cases)) {
    const outcome = runPaidAdvertisingTool(researchParams);
    console.log(`--- ${label} -> status: ${outcome.status} ---`);
    if (outcome.error) console.log(`  error: ${outcome.error}`);
    console.log('');
  }

  console.log('No finding above is real - every value is a caller-supplied placeholder for demonstration.');
}
