'use strict';

// The market_research tool (tools/toolRegistry.js): connects the Chief/Orchestrator to
// agent/core/researchAgent.js's runMarketResearch(). Thin wrapper - no new research
// logic is added here, only structured input handling and an honest outcome status.
//
// The orchestrator (agent/core/orchestratorExecutionContract.js) only threads a
// free-text objective through by default; structured research input (market,
// demandSignals, evidence, etc.) must arrive via executionRequest.research_params (an
// optional passthrough - see runOrchestratorContract's second argument). When it's
// missing, this tool reports that honestly instead of guessing parameters from the
// objective text - a missing external source (here, the caller-supplied structured
// input itself, since no other data source is configured) is never replaced with
// fabricated information.
//
// Returns { status, result, error } - never throws:
//   status 'failed'  - no researchParams supplied, or a required field was missing
//                       (result is null, error explains why)
//   status 'empty'   - valid input, but no evidence/source was supplied anywhere
//   status 'success' - valid input with evidence/source for the composed record
// (market_research composes exactly one record, so 'partial' never applies here - see
// competitorResearchTool.js / customerResearchTool.js, which accept multiple entries.)

const { runMarketResearch } = require('../agent/core/researchAgent');

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

function runMarketResearchTool(researchParams) {
  if (!researchParams || typeof researchParams !== 'object') {
    return {
      status: 'failed',
      result: null,
      error:
        'No structured research input was supplied - market_research requires structured parameters (e.g. market, evidence) that a free-text objective cannot provide.',
    };
  }

  try {
    const result = runMarketResearch(researchParams);
    return { status: deriveStatus(result), result, error: null };
  } catch (err) {
    return { status: 'failed', result: null, error: err.message };
  }
}

module.exports = { runMarketResearchTool };

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - market_research tool:\n');

  const cases = {
    'no researchParams': undefined,
    'missing required field (failed)': { demandSignals: ['(placeholder demand signal)'] },
    'no evidence supplied (empty)': {
      market: 'European Union',
      demandSignals: ['(placeholder demand signal)'],
    },
    'evidence supplied (success)': {
      market: 'European Union',
      demandSignals: ['(placeholder demand signal)'],
      evidence: ['(placeholder source reference)'],
    },
  };

  for (const [label, researchParams] of Object.entries(cases)) {
    const outcome = runMarketResearchTool(researchParams);
    console.log(`--- ${label} -> status: ${outcome.status} ---`);
    if (outcome.error) console.log(`  error: ${outcome.error}`);
    console.log('');
  }

  console.log('No finding above is real - every value is a caller-supplied placeholder for demonstration.');
}
