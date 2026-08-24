'use strict';

// The keyword_research tool (tools/toolRegistry.js): connects the Chief/Orchestrator
// to agent/core/seoAgent.js's runKeywordResearch() and analyzeSearchIntent(). Thin
// wrapper - no new keyword-research logic is added here, only structured input
// handling and an honest outcome status, matching tools/marketResearchTool.js's
// convention exactly.
//
// The orchestrator (agent/core/orchestratorExecutionContract.js) only threads a
// free-text objective through by default; structured keyword input (keywords, market,
// evidence, etc.) must arrive via executionRequest.research_params (the same optional
// passthrough every research/SEO tool uses). When it's missing, this tool reports that
// honestly instead of guessing keywords from the objective text.
//
// Returns { status, result, error } - never throws:
//   status 'failed'  - no researchParams supplied, or a required field was missing
//   status 'empty'   - valid input, but no keyword ended up evidence-backed
//   status 'success' - valid input, every keyword ended up evidence-backed
//   status 'partial' - valid input, some but not all keywords ended up evidence-backed
//
// researchParams.seoCapability selects which of the two keyword-set capabilities to
// run: 'search_intent_analysis' for analyzeSearchIntent(), anything else (including
// omitted) defaults to runKeywordResearch() - this tool id covers both capabilities
// since they operate on the same input shape (a set of keywords).

const { runKeywordResearch, analyzeSearchIntent } = require('../agent/core/seoAgent');

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

function runKeywordResearchTool(researchParams) {
  if (!researchParams || typeof researchParams !== 'object') {
    return {
      status: 'failed',
      result: null,
      error:
        'No structured research input was supplied - keyword_research requires structured parameters (e.g. keywords, evidence) that a free-text objective cannot provide.',
    };
  }

  try {
    const { seoCapability, ...params } = researchParams;
    const result = seoCapability === 'search_intent_analysis'
      ? analyzeSearchIntent(params)
      : runKeywordResearch(params);
    return { status: deriveStatus(result), result, error: null };
  } catch (err) {
    return { status: 'failed', result: null, error: err.message };
  }
}

module.exports = { runKeywordResearchTool };

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - keyword_research tool:\n');

  const cases = {
    'no researchParams': undefined,
    'missing required field (failed)': { keywords: [{}] },
    'no evidence supplied (empty)': {
      keywords: [{ keyword: 'insulated hiking jacket' }],
    },
    'evidence supplied (success)': {
      keywords: [{ keyword: 'insulated hiking jacket', source: ['(placeholder source)'] }],
    },
    'search intent analysis capability': {
      seoCapability: 'search_intent_analysis',
      keywords: [{ keyword: 'insulated hiking jacket', searchIntent: 'commercial investigation' }],
    },
  };

  for (const [label, researchParams] of Object.entries(cases)) {
    const outcome = runKeywordResearchTool(researchParams);
    console.log(`--- ${label} -> status: ${outcome.status} ---`);
    if (outcome.error) console.log(`  error: ${outcome.error}`);
    console.log('');
  }

  console.log('No finding above is real - every value is a caller-supplied placeholder for demonstration.');
}
