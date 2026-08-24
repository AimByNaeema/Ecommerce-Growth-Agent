'use strict';

// The advertising_strategy_planning tool (tools/toolRegistry.js): connects the
// Chief/Orchestrator to agent/core/socialAdvertisingAgent.js's advertising_strategy
// capability. Thin wrapper - no new strategy logic is added here, only structured
// input handling and an honest outcome status, matching
// tools/socialMediaStrategyTool.js's convention exactly.
//
// The orchestrator (agent/core/orchestratorExecutionContract.js) only threads a
// free-text objective through by default; structured input (strategyReference,
// campaignObjective, offer, creativeAngle, adCopy, budgetRecommendation, kpi,
// testingPlan, evidence, etc.) must arrive via executionRequest.research_params (the
// same optional passthrough every research/SEO/listing/marketing/social tool uses).
// When it's missing, this tool reports that honestly instead of guessing parameters
// from the objective text.
//
// No advertising budget is ever spent and no campaign is ever launched here - this
// tool has no execute/launch/spend function of any kind.
//
// Returns { status, result, error } - never throws:
//   status 'failed'  - no researchParams supplied, or a required field was missing
//   status 'empty'   - valid input, but no evidence/source was supplied
//   status 'success' - valid input, the underlying record ended up evidence-backed

const { analyzeAdvertisingStrategy } = require('../agent/core/socialAdvertisingAgent');

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

function runAdvertisingStrategyTool(researchParams) {
  if (!researchParams || typeof researchParams !== 'object') {
    return {
      status: 'failed',
      result: null,
      error:
        'No structured research input was supplied - advertising_strategy_planning requires structured parameters (e.g. strategyReference, campaignObjective) that a free-text objective cannot provide.',
    };
  }

  try {
    const result = analyzeAdvertisingStrategy(researchParams);
    return { status: deriveStatus(result), result, error: null };
  } catch (err) {
    return { status: 'failed', result: null, error: err.message };
  }
}

module.exports = { runAdvertisingStrategyTool };

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - advertising_strategy_planning tool:\n');

  const cases = {
    'no researchParams': undefined,
    'missing required field (failed)': { strategyReference: '' },
    'no evidence supplied (empty)': {
      strategyReference: '(Example winter jacket launch strategy)',
      campaignObjective: 'Drive first-week sales (caller-supplied placeholder).',
      offer: '15% off for the first week (caller-supplied placeholder).',
      creativeAngle: 'Warmth without the premium price tag (caller-supplied placeholder).',
    },
    'evidence supplied (success)': {
      strategyReference: '(Example winter jacket launch strategy)',
      campaignObjective: 'Drive first-week sales (caller-supplied placeholder).',
      offer: '15% off for the first week (caller-supplied placeholder).',
      creativeAngle: 'Warmth without the premium price tag (caller-supplied placeholder).',
      evidence: ['(placeholder prior-campaign result)'],
    },
  };

  for (const [label, researchParams] of Object.entries(cases)) {
    const outcome = runAdvertisingStrategyTool(researchParams);
    console.log(`--- ${label} -> status: ${outcome.status} ---`);
    if (outcome.error) console.log(`  error: ${outcome.error}`);
    console.log('');
  }

  console.log('No finding above is real - every value is a caller-supplied placeholder for demonstration.');
}
