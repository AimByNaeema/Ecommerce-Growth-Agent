'use strict';

// The platform_content_generation tool (tools/toolRegistry.js): connects the
// Chief/Orchestrator to agent/core/socialAdvertisingAgent.js's content_generation
// capability. Thin wrapper - no new content logic is added here, only structured
// input handling and an honest outcome status, matching
// tools/marketingAnalysisTool.js's convention exactly.
//
// The orchestrator (agent/core/orchestratorExecutionContract.js) only threads a
// free-text objective through by default; structured input (platform, contentReference,
// hooks, captions, ctas, contentIdeas, shortFormVideoConcepts, carouselConcepts,
// creativeBriefs, evidence, etc.) must arrive via executionRequest.research_params (the
// same optional passthrough every research/SEO/listing/marketing/social tool uses).
// When it's missing, this tool reports that honestly instead of guessing parameters
// from the objective text.
//
// Unlike tools/socialContentTool.js and tools/paidAdvertisingTool.js, there is only one
// capability here and `platform` is a required field on the record itself, not a
// dispatch key - callers select the platform every content set is adapted to.
//
// Returns { status, result, error } - never throws:
//   status 'failed'  - no researchParams supplied, or a required field was missing
//   status 'empty'   - valid input, but no evidence/source was supplied
//   status 'success' - valid input, the underlying record ended up evidence-backed

const { analyzeContentGeneration } = require('../agent/core/socialAdvertisingAgent');

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

function runPlatformContentTool(researchParams) {
  if (!researchParams || typeof researchParams !== 'object') {
    return {
      status: 'failed',
      result: null,
      error:
        'No structured research input was supplied - platform_content_generation requires structured parameters (e.g. platform, contentReference, hooks, captions) that a free-text objective cannot provide.',
    };
  }

  try {
    const result = analyzeContentGeneration(researchParams);
    return { status: deriveStatus(result), result, error: null };
  } catch (err) {
    return { status: 'failed', result: null, error: err.message };
  }
}

module.exports = { runPlatformContentTool };

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - platform_content_generation tool:\n');

  const cases = {
    'no researchParams': undefined,
    'missing required field (failed)': { platform: 'tiktok', contentReference: '' },
    'unknown platform (failed)': { platform: 'snapchat', contentReference: '(Example content)' },
    'no evidence supplied (empty)': {
      platform: 'tiktok',
      contentReference: '(Example jacket launch content set)',
      hooks: ['You\'re about to see the warmest $80 jacket on the internet (caller-supplied placeholder).'],
      captions: ['Stay warm this winter without breaking the bank (caller-supplied placeholder).'],
    },
    'evidence supplied (success)': {
      platform: 'tiktok',
      contentReference: '(Example jacket launch content set)',
      hooks: ['You\'re about to see the warmest $80 jacket on the internet (caller-supplied placeholder).'],
      captions: ['Stay warm this winter without breaking the bank (caller-supplied placeholder).'],
      evidence: ['(placeholder prior-video performance)'],
    },
  };

  for (const [label, researchParams] of Object.entries(cases)) {
    const outcome = runPlatformContentTool(researchParams);
    console.log(`--- ${label} -> status: ${outcome.status} ---`);
    if (outcome.error) console.log(`  error: ${outcome.error}`);
    console.log('');
  }

  console.log('No finding above is real - every value is a caller-supplied placeholder for demonstration.');
}
