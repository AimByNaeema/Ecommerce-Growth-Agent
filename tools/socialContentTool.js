'use strict';

// The social_content_planning tool (tools/toolRegistry.js): connects the
// Chief/Orchestrator to agent/core/socialAdvertisingAgent.js's 5 social-platform
// capabilities. Thin wrapper - no new social logic is added here, only structured
// input handling, platform dispatch, and an honest outcome status, matching
// tools/marketingAnalysisTool.js's convention exactly.
//
// The orchestrator (agent/core/orchestratorExecutionContract.js) only threads a
// free-text objective through by default; structured input (platform, contentReference,
// caption, hashtags, evidence, etc.) must arrive via executionRequest.research_params
// (the same optional passthrough every research/SEO/listing/marketing tool uses). When
// it's missing, this tool reports that honestly instead of guessing parameters from
// the objective text.
//
// researchParams.socialPlatform selects which capability to run - one of 'instagram'
// (default when omitted), 'facebook', 'tiktok', 'pinterest', or 'youtube'.
//
// Returns { status, result, error } - never throws:
//   status 'failed'  - no researchParams supplied, an unknown socialPlatform, or a
//                       required field was missing
//   status 'empty'   - valid input, but no evidence/source was supplied
//   status 'success' - valid input, the underlying record ended up evidence-backed
//   status 'partial' - reserved for future multi-record use; today one record in,
//                       one out, so this tool only ever reports 'empty' or 'success'
//                       once input is valid.

const {
  analyzeInstagram,
  analyzeFacebook,
  analyzeTiktok,
  analyzePinterest,
  analyzeYoutube,
} = require('../agent/core/socialAdvertisingAgent');

const CAPABILITY_HANDLERS = {
  instagram: analyzeInstagram,
  facebook: analyzeFacebook,
  tiktok: analyzeTiktok,
  pinterest: analyzePinterest,
  youtube: analyzeYoutube,
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

function runSocialContentTool(researchParams) {
  if (!researchParams || typeof researchParams !== 'object') {
    return {
      status: 'failed',
      result: null,
      error:
        'No structured research input was supplied - social_content_planning requires structured parameters (e.g. contentReference, caption) that a free-text objective cannot provide.',
    };
  }

  const { socialPlatform = 'instagram', ...params } = researchParams;
  const handler = CAPABILITY_HANDLERS[socialPlatform];
  if (!handler) {
    return {
      status: 'failed',
      result: null,
      error: `Unknown socialPlatform: ${socialPlatform}. Must be one of: ${Object.keys(CAPABILITY_HANDLERS).join(', ')}`,
    };
  }

  try {
    const result = handler(params);
    return { status: deriveStatus(result), result, error: null };
  } catch (err) {
    return { status: 'failed', result: null, error: err.message };
  }
}

module.exports = { runSocialContentTool };

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - social_content_planning tool:\n');

  const cases = {
    'no researchParams': undefined,
    'unknown socialPlatform (failed)': { socialPlatform: 'not_a_real_platform' },
    'missing required field (failed)': { contentReference: '' },
    'no evidence supplied (empty)': {
      socialPlatform: 'instagram',
      contentReference: '(Example winter jacket launch post)',
      caption: 'Stay warm this winter (caller-supplied placeholder).',
    },
    'evidence supplied (success)': {
      socialPlatform: 'instagram',
      contentReference: '(Example winter jacket launch post)',
      caption: 'Stay warm this winter (caller-supplied placeholder).',
      evidence: ['(placeholder prior-post performance)'],
    },
  };

  for (const [label, researchParams] of Object.entries(cases)) {
    const outcome = runSocialContentTool(researchParams);
    console.log(`--- ${label} -> status: ${outcome.status} ---`);
    if (outcome.error) console.log(`  error: ${outcome.error}`);
    console.log('');
  }

  console.log('No finding above is real - every value is a caller-supplied placeholder for demonstration.');
}
