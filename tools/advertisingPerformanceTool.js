'use strict';

// The advertising_performance_analysis tool (tools/toolRegistry.js): connects the
// Chief/Orchestrator to agent/core/socialAdvertisingAgent.js's advertising_performance
// capability. Thin wrapper - no new metric logic is added here, only structured input
// handling and an honest outcome status, matching
// tools/advertisingStrategyTool.js's convention exactly.
//
// The orchestrator (agent/core/orchestratorExecutionContract.js) only threads a
// free-text objective through by default; structured input (performanceReference,
// campaignReference, actualMetrics, evidence, etc.) must arrive via
// executionRequest.research_params (the same optional passthrough every research/SEO/
// listing/marketing/social tool uses). When it's missing, this tool reports that
// honestly instead of guessing metric values from the objective text.
//
// No metric is ever fetched, estimated, or fabricated here - this tool has no
// fetch/pull/sync/calculation logic of any kind; calculation itself lives in
// agent/core/advertisingPerformanceCalculator.js, called by the agent, not by this
// tool.
//
// Returns { status, result, error } - never throws:
//   status 'failed'  - no researchParams supplied, or a required field was missing
//   status 'empty'   - valid input, but no evidence/source was supplied
//   status 'success' - valid input, the underlying record ended up evidence-backed

const { analyzeAdvertisingPerformance } = require('../agent/core/socialAdvertisingAgent');

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

function runAdvertisingPerformanceTool(researchParams) {
  if (!researchParams || typeof researchParams !== 'object') {
    return {
      status: 'failed',
      result: null,
      error:
        'No structured research input was supplied - advertising_performance_analysis requires structured parameters (e.g. performanceReference, actualMetrics) that a free-text objective cannot provide.',
    };
  }

  try {
    const result = analyzeAdvertisingPerformance(researchParams);
    return { status: deriveStatus(result), result, error: null };
  } catch (err) {
    return { status: 'failed', result: null, error: err.message };
  }
}

module.exports = { runAdvertisingPerformanceTool };

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - advertising_performance_analysis tool:\n');

  const cases = {
    'no researchParams': undefined,
    'missing required field (failed)': { performanceReference: '' },
    'no evidence supplied (empty)': {
      performanceReference: '(Example winter jacket launch - week 1 performance)',
      actualMetrics: { impressions: 10000, clicks: 250, spend: 500 },
    },
    'evidence supplied (success)': {
      performanceReference: '(Example winter jacket launch - week 1 performance)',
      actualMetrics: { impressions: 10000, clicks: 250, spend: 500, conversions: 20, revenue: 1000 },
      evidence: ['(placeholder Meta Ads Manager export)'],
    },
  };

  for (const [label, researchParams] of Object.entries(cases)) {
    const outcome = runAdvertisingPerformanceTool(researchParams);
    console.log(`--- ${label} -> status: ${outcome.status} ---`);
    if (outcome.error) console.log(`  error: ${outcome.error}`);
    console.log('');
  }

  console.log('No finding above is real - every value is a caller-supplied placeholder for demonstration.');
}
