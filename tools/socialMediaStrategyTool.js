'use strict';

// The social_media_strategy_generation tool (tools/toolRegistry.js): connects the
// Chief/Orchestrator to agent/core/socialAdvertisingAgent.js's social_media_strategy
// capability. Thin wrapper - no new strategy logic is added here, only structured
// input handling and an honest outcome status, matching
// tools/marketingAnalysisTool.js's convention exactly.
//
// The orchestrator (agent/core/orchestratorExecutionContract.js) only threads a
// free-text objective through by default; structured input (strategyReference,
// contentPillars, platformSelection, kpis, evidence, etc.) must arrive via
// executionRequest.research_params (the same optional passthrough every research/SEO/
// listing/marketing/social tool uses). When it's missing, this tool reports that
// honestly instead of guessing parameters from the objective text.
//
// Unlike tools/socialContentTool.js and tools/paidAdvertisingTool.js, there is only one
// capability here - no platform-selection dispatch key is needed.
//
// Returns { status, result, error } - never throws:
//   status 'failed'  - no researchParams supplied, or a required field was missing
//   status 'empty'   - valid input, but no evidence/source was supplied
//   status 'success' - valid input, the underlying record ended up evidence-backed

const { analyzeSocialMediaStrategy } = require('../agent/core/socialAdvertisingAgent');

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

function runSocialMediaStrategyTool(researchParams) {
  if (!researchParams || typeof researchParams !== 'object') {
    return {
      status: 'failed',
      result: null,
      error:
        'No structured research input was supplied - social_media_strategy_generation requires structured parameters (e.g. strategyReference, contentPillars) that a free-text objective cannot provide.',
    };
  }

  try {
    const result = analyzeSocialMediaStrategy(researchParams);
    return { status: deriveStatus(result), result, error: null };
  } catch (err) {
    return { status: 'failed', result: null, error: err.message };
  }
}

module.exports = { runSocialMediaStrategyTool };

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - social_media_strategy_generation tool:\n');

  const cases = {
    'no researchParams': undefined,
    'missing required field (failed)': { strategyReference: '' },
    'no evidence supplied (empty)': {
      strategyReference: '(Example Q4 winter strategy)',
      objective: 'Grow winter jacket line awareness (caller-supplied placeholder).',
      contentPillars: ['Product education', 'Customer stories'],
      platformSelection: ['instagram', 'tiktok'],
    },
    'evidence supplied (success)': {
      strategyReference: '(Example Q4 winter strategy)',
      objective: 'Grow winter jacket line awareness (caller-supplied placeholder).',
      contentPillars: ['Product education', 'Customer stories'],
      platformSelection: ['instagram', 'tiktok'],
      evidence: ['(placeholder prior-quarter performance)'],
    },
  };

  for (const [label, researchParams] of Object.entries(cases)) {
    const outcome = runSocialMediaStrategyTool(researchParams);
    console.log(`--- ${label} -> status: ${outcome.status} ---`);
    if (outcome.error) console.log(`  error: ${outcome.error}`);
    console.log('');
  }

  console.log('No finding above is real - every value is a caller-supplied placeholder for demonstration.');
}
